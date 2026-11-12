import type { PromptKind, Run } from "@/lib/contracts/run";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import type { Cell, EvidenceView } from "@/lib/contracts/view-model";
import { getByPointer, isWithin } from "@/lib/pipeline/json-pointer";
import { getPrompt, getVersion, type PromptVersion } from "@/lib/repositories/prompts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readOriginalAt } from "@/lib/materials/original-reader";
import { resolveMaterialFile } from "@/lib/materials/store";
import { getRun, listAnnotations } from "@/lib/repositories/runs";
import { getSnapshot } from "@/lib/repositories/snapshots";
import { compareRuns, diffSummary } from "./compare";
import { captureQuality, diagnosticStates, fieldInputCoverage } from "./run-evidence";
import { pdfPageCount, renderPdfPage } from "./page-images";
import { contextFromSnapshot } from "./service";

// Run Debug Bundle（v1.3 §5.2）：按需动态组装，不复制一份目录。
// 只读 Run 当时真实保存的内容；没保存的如实标 available:false 并说明限制，不重新生成、不推断补齐。
// MCP 工具与（以后的）Web 接口都用这里，授权在调用方完成。

export const BUNDLE_VERSION = "run-debug-bundle@1.0.0";
/** 单个文本片段的默认字符上限；更多内容用 offset 分段读取（§7.5） */
export const PART_LIMIT = 20_000;

export class BundleError extends Error {
  constructor(
    public code: "NOT_FOUND" | "AMBIGUOUS_OBJECT_REF" | "SOURCE_REF_NOT_IN_RUN" | "BAD_REQUEST",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface RunContext {
  run: Run;
  snapshot?: InputSnapshot;
  /** 运行的构造输入：优先 Run 自带副本；没有时取自输入快照（快照内容不可变，但这不是运行时副本） */
  request: unknown;
  request_origin: "RUN_BUILT_INPUT" | "SNAPSHOT" | "NONE";
  customer_id: string | null;
  has_gold: boolean;
}

const stage = (k: PromptKind) => (k.startsWith("JIULI_") ? k.slice(6) : k);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 截取一段文本：返回片段、总长度与下一段的 offset（读完为 null） */
export function clip(text: string, offset = 0, limit = PART_LIMIT) {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + limit);
  return { text: text.slice(start, end), offset: start, total_chars: text.length, next_offset: end < text.length ? end : null };
}

/**
 * Run 属于哪个客户（用于客户级授权）：九立只读快照记录的客户；否则请求上下文里的 customer_id；
 * 请求里只列出唯一一个候选客户时取它。都没有为 null（客户未知）。模型输出里的客户不可信，不用。
 */
function customerOf(snapshot: InputSnapshot | undefined, request: unknown): string | null {
  const fromSnap = snapshot?.source_ids?.customer_id;
  if (typeof fromSnap === "string") return fromSnap;
  const ctx = obj(obj(request).context);
  if (typeof ctx.customer_id === "string") return ctx.customer_id;
  const dir = Array.isArray(ctx.customer_directory) ? ctx.customer_directory : [];
  return dir.length === 1 && typeof obj(dir[0]).customer_id === "string" ? (obj(dir[0]).customer_id as string) : null;
}

/** 输入快照属于哪个客户（实验授权用）：规则同 customerOf，请求取自快照 */
export function snapshotCustomer(snapshot: InputSnapshot, kind: PromptKind): string | null {
  return customerOf(snapshot, contextFromSnapshot("", kind, snapshot).request);
}

export function loadRunContext(runId: string): RunContext | undefined {
  const run = getRun(runId);
  if (!run) return undefined;
  const snapshot = run.input_snapshot_id ? getSnapshot(run.input_snapshot_id) : undefined;
  const fromSnap = snapshot ? contextFromSnapshot(run.run_id, run.prompt_kind, snapshot) : undefined;
  const request = run.built_input ?? fromSnap?.request ?? null;
  return {
    run,
    snapshot,
    request,
    request_origin: run.built_input !== undefined ? "RUN_BUILT_INPUT" : fromSnap?.request ? "SNAPSHOT" : "NONE",
    customer_id: customerOf(snapshot, request),
    has_gold: !!fromSnap?.gold,
  };
}

/** run-manifest：运行标识、各层版本、采集完整度、诊断状态与可读取的部分 */
export function runManifest(c: RunContext) {
  const { run } = c;
  const prompt = getPrompt(run.prompt_id);
  const capture = captureQuality(run);
  const diag = diagnosticStates(run, { activeSchemaVersion: prompt?.active_schema_version, hasGold: c.has_gold });
  const anns = listAnnotations(run.run_id);
  const m = run.input_manifest;
  return {
    bundle_version: BUNDLE_VERSION,
    run_id: run.run_id,
    project_id: run.project_id,
    prompt_stage: stage(run.prompt_kind),
    prompt_id: run.prompt_id,
    customer_scope: c.customer_id,
    label: (run as Run & { label?: string }).label ?? null,
    mode: run.mode,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at ?? null,
    error: run.error ?? null,
    capture_quality: capture.quality,
    not_captured: capture.not_captured,
    capture_notes: capture.notes,
    diagnostic_states: diag.states,
    warnings: diag.warnings,
    versions: {
      prompt_version_id: run.prompt_version_id ?? null,
      prompt_version_label: run.prompt_version_id ? (getVersion(run.prompt_version_id)?.label ?? null) : null,
      is_unsaved_draft: run.is_unsaved_draft,
      actual_prompt_hash: run.actual_prompt_hash ?? null,
      schema_id: run.schema_id ?? null,
      schema_version: run.schema_version ?? null,
      active_schema_version: prompt?.active_schema_version ?? null,
      adapter_id: run.adapter_id ?? null,
      adapter_version: run.adapter_version ?? null,
      renderer_config_version: run.renderer_config_version ?? null,
      input_builder: m?.input_builder ?? null,
      input_manifest_version: m?.version ?? null,
      preprocessor_versions: m ? [...new Set(m.files.map((f) => f.preprocessor_version).filter(Boolean))] : null,
      provider_adapter_version: run.provider_adapter_version ?? null,
      ruleset_version: null,
    },
    model: {
      provider: run.model_provider ?? null,
      name: run.model_name ?? null,
      reported_model: (run.response_meta?.model as string | undefined) ?? null,
      params: run.model_params ?? null,
      finish_reason: run.finish_reason ?? null,
      token_usage: run.token_usage ?? null,
      latency_ms: run.latency_ms ?? null,
      timing: run.timing ?? null,
      egress: run.egress ?? null,
      cost: null,
      cost_note: "服务商不返回价格，Studio 不估算",
    },
    input: {
      snapshot_id: run.input_snapshot_id ?? null,
      snapshot_available: !!c.snapshot,
      snapshot_source_type: c.snapshot?.source_type ?? null,
      snapshot_hash: c.snapshot?.content_hash ?? m?.snapshot_hash ?? null,
      fixture_id: (c.snapshot?.source_ids?.fixture_id as string | undefined) ?? null,
      built_input_hash: run.built_input_hash ?? null,
      request_origin: c.request_origin,
      attached_images: run.attached_images === undefined || run.attached_images === null ? null : run.attached_images.length,
      input_complete: m ? m.complete : null,
      input_gaps: m?.gaps ?? null,
    },
    raw_response: { available: !!run.raw_response_hash, sha256: run.raw_response_hash || null, chars: run.raw_response.length },
    upstream: { run_ids: run.upstream_run_ids ?? null, note: run.upstream_note ?? null },
    replay_of_run_id: run.replay_of_run_id ?? null,
    retry_of_run_id: run.retry_of_run_id ?? null,
    annotations: { count: anns.length, wrong: anns.filter((a) => a.assessment === "WRONG").length, latest_revision: anns.reduce((n, a) => Math.max(n, a.revision ?? 1), 0) },
    capabilities: {
      raw_request_captured: !!run.request_actual,
      built_input_captured: run.built_input !== undefined,
      input_manifest_captured: !!m,
      response_meta_captured: !!run.response_meta,
      adapter_diagnostics_captured: run.adapter_diagnostics !== undefined,
      source_image_sent: !!run.attached_images?.length,
      view_model_available: !!run.view_model,
    },
  };
}

export const TRACE_PARTS = ["actual_request", "built_input", "preprocessing", "raw_response", "schema", "adapter", "provenance"] as const;
export type TracePart = (typeof TRACE_PARTS)[number];

export interface ObjectRef {
  table_id?: string;
  row_id?: string;
  field?: string;
  json_pointer?: string;
}

const missing = (reason: string) => ({ available: false as const, reason });

/** 把 object_ref 解析成 ViewModel 里的格子；找不到 / 多处匹配明确报错，不猜 */
export function resolveObject(run: Run, ref: ObjectRef): { table_id: string | null; row_id: string | null; field: string | null; cell: Cell | null; json_pointer: string } {
  const tables = (run.view_model?.tables ?? []).filter((t) => !ref.table_id || t.id === ref.table_id);
  if (ref.row_id && ref.field) {
    const hits = tables.flatMap((t) => t.rows.filter((r) => r.id === ref.row_id && r.cells[ref.field!]).map((r) => ({ t, cell: r.cells[ref.field!] })));
    if (!hits.length) {
      const rowTables = tables.filter((t) => t.rows.some((r) => r.id === ref.row_id));
      throw new BundleError("NOT_FOUND", rowTables.length ? `行 ${ref.row_id} 没有字段 ${ref.field}` : `这个 Run 的结果里没有行 ${ref.row_id}`, {
        tables: tables.map((t) => ({ table_id: t.id, title: t.title, row_ids: t.rows.slice(0, 30).map((r) => r.id), fields: t.columns.map((c) => c.key) })),
      });
    }
    if (hits.length > 1) throw new BundleError("AMBIGUOUS_OBJECT_REF", `行 ${ref.row_id} 的 ${ref.field} 出现在多张表里，请加 table_id`, { table_ids: hits.map((h) => h.t.id) });
    return { table_id: hits[0].t.id, row_id: ref.row_id, field: ref.field, cell: hits[0].cell, json_pointer: hits[0].cell.jsonPointer };
  }
  if (ref.json_pointer !== undefined) {
    const hits = tables.flatMap((t) => t.rows.flatMap((r) => Object.values(r.cells).filter((c) => c.jsonPointer === ref.json_pointer).map((cell) => ({ t, cell }))));
    if (hits.length > 1) throw new BundleError("AMBIGUOUS_OBJECT_REF", "这个 JSON 位置对应多个表格格子，请改用 table_id + row_id + field", { cells: hits.map((h) => ({ table_id: h.t.id, row_id: h.cell.rowId, field: h.cell.fieldKey })) });
    if (hits.length === 1) return { table_id: hits[0].t.id, row_id: hits[0].cell.rowId, field: hits[0].cell.fieldKey, cell: hits[0].cell, json_pointer: ref.json_pointer };
    try {
      if (getByPointer(run.parsed_json, ref.json_pointer).found) return { table_id: null, row_id: null, field: null, cell: null, json_pointer: ref.json_pointer };
    } catch {
      throw new BundleError("BAD_REQUEST", `不是合法的 JSON Pointer：${ref.json_pointer}`);
    }
    // 模型漏掉的位置（如缺少必填字段）：人工标注明确指向它时，按这个位置定位（「这里本该有内容」）
    if (listAnnotations(run.run_id).some((a) => a.target_json_pointer === ref.json_pointer)) return { table_id: null, row_id: null, field: null, cell: null, json_pointer: ref.json_pointer };
    throw new BundleError("NOT_FOUND", `模型输出里没有这个位置：${ref.json_pointer}`);
  }
  throw new BundleError("BAD_REQUEST", "object_ref 需要 row_id + field，或 json_pointer");
}

const evidenceOf = (run: Run, ids: string[]) => ids.map((id) => run.view_model?.evidence.find((e) => e.id === id)).filter((e): e is EvidenceView => !!e);

/** 对象级证据：表格值、模型原始节点、来源、实际输入覆盖、相关问题与 Schema 诊断 */
function objectTrace(c: RunContext, ref: ObjectRef) {
  const { run } = c;
  const o = resolveObject(run, ref);
  const raw = getByPointer(run.parsed_json, o.json_pointer);
  const refs = o.cell?.sourceRefIds ?? [];
  const ev = evidenceOf(run, refs);
  return {
    requested_scope: ref,
    resolved: { table_id: o.table_id, row_id: o.row_id, field: o.field, json_pointer: o.json_pointer },
    display_value: o.cell ? o.cell.value : null,
    cell_state: o.cell?.state ?? null,
    raw_output_node: raw.found ? clip(JSON.stringify(raw.value, null, 1), 0, 4000) : null,
    adapter_converted: o.cell && raw.found ? JSON.stringify(o.cell.value) !== JSON.stringify(raw.value) : null,
    evidence_refs: refs,
    evidence: ev,
    missing_evidence_refs: refs.filter((id) => !ev.some((e) => e.id === id)),
    input_coverage: fieldInputCoverage(ev, run.input_manifest, run.mode),
    related_issues: (run.view_model?.issues ?? []).filter((i) => (o.row_id && i.target?.rowId === o.row_id && (!i.target.fieldKey || i.target.fieldKey === o.field)) || (i.target?.jsonPointer && isWithin(i.target.jsonPointer, o.json_pointer))),
    schema_diagnostics: [...run.parse_diagnostics, ...run.schema_diagnostics].filter((d) => d.jsonPointer && (isWithin(d.jsonPointer, o.json_pointer) || isWithin(o.json_pointer, d.jsonPointer))),
  };
}

/** run-trace：按需返回各部分；没采集的部分 available:false 并说明 */
export function runTrace(c: RunContext, parts: TracePart[], objectRef?: ObjectRef, offset = 0) {
  const { run } = c;
  const out: Record<string, unknown> = {};
  const limitations: string[] = [];
  for (const p of parts) {
    if (p === "actual_request") out[p] = run.request_actual ? { available: true, data: run.request_actual } : missing(run.mode === "MODEL_RUN" ? "这条 Run 没有保存实际请求结构（v1.3 之前的运行）" : "没有调用模型，不存在请求");
    else if (p === "built_input") {
      if (run.built_input !== undefined) out[p] = { available: true, origin: "RUN_BUILT_INPUT", ...clip(JSON.stringify(run.built_input, null, 1), offset) };
      else if (c.request) out[p] = { available: false, reason: "这条 Run 没有保存构造输入副本", snapshot_request_available: true, note: "可用 get_source_evidence 按来源读取输入快照中的内容；快照不是运行时副本" };
      else out[p] = missing("这条 Run 没有构造输入副本，输入快照也不可用（已删除、到期或没有快照）");
    } else if (p === "preprocessing") {
      out[p] = run.input_manifest
        ? { available: true, input_manifest: run.input_manifest, attached_images: run.attached_images ?? null }
        : missing(run.mode === "MODEL_RUN" ? "这条 Run 没有输入覆盖清单（v1.1 之前），不知道哪些页 / Sheet 进入了模型" : "没有调用模型，不存在预处理");
    } else if (p === "raw_response") {
      out[p] = run.raw_response_hash
        ? { available: true, sha256: run.raw_response_hash, finish_reason: run.finish_reason ?? null, response_meta: run.response_meta ?? null, ...clip(run.raw_response, offset) }
        : missing(run.status === "RUNNING" ? "运行中，还没有原始响应" : "没有原始响应（模型调用失败或被取消）");
    } else if (p === "schema") {
      out[p] = { available: true, status: run.status, schema_id: run.schema_id ?? null, schema_version: run.schema_version ?? null, parse_diagnostics: run.parse_diagnostics, schema_diagnostics: run.schema_diagnostics };
    } else if (p === "adapter") {
      out[p] =
        run.adapter_diagnostics !== undefined
          ? { available: true, adapter_id: run.adapter_id ?? null, adapter_version: run.adapter_version ?? null, diagnostics: run.adapter_diagnostics }
          : { available: false, reason: "这条 Run 没有单独保存 Adapter 诊断（v1.3 之前）", adapter_id: run.adapter_id ?? null, adapter_version: run.adapter_version ?? null, view_model_diagnostics: run.view_model?.diagnostics.filter((d) => d.phase === "ADAPTER" || d.phase === "RENDER") ?? null };
    } else if (p === "provenance") {
      const vm = run.view_model;
      out[p] = vm
        ? {
            available: true,
            tables: vm.tables.map((t) => ({ table_id: t.id, title: t.title, rows: t.rows.length, fields: t.columns.map((col) => col.key), row_ids: t.rows.slice(0, 50).map((r) => r.id) })),
            evidence_count: vm.evidence.length,
            cells_without_source: vm.tables.reduce((n, t) => n + t.rows.reduce((m, r) => m + Object.values(r.cells).filter((x) => !x.sourceRefIds.length).length, 0), 0),
          }
        : missing("没有业务视图（解析失败、模型出错或 Adapter 出错）");
    }
    const part = out[p] as { available: boolean; reason?: string } | undefined;
    if (part && !part.available && part.reason) limitations.push(`${p}：${part.reason}`);
  }
  return {
    run_id: run.run_id,
    capture_quality: captureQuality(run).quality,
    ...(objectRef ? { object: objectTrace(c, objectRef) } : {}),
    parts: out,
    limitations,
  };
}

/** Excel 列字母 → 列号（A=1） */
const colNum = (col: string) => (/^[A-Z]+$/i.test(col) ? [...col.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) : Number(col));
const norm = (s: string) => s.replace(/\s+/g, "");

/** 在构造输入的材料里找到来源指向的位置（页文本 / Sheet 单元格），只读输入，不读任意文件 */
function locateInInput(request: unknown, e: EvidenceView, view: "snippet" | "page") {
  const input = obj(obj(request).input);
  const files = [...(Array.isArray(input.materials) ? input.materials : []), ...(Array.isArray(input.files) ? input.files : [])].map(obj);
  const f = files.find((x) => x.file_id === e.fileId);
  if (!f) return { found: false, reason: "这个文件不在本次构造输入里" };
  const content = obj(f.content);
  if (f.content === null || f.content === undefined) return { found: false, reason: "输入里这个文件没有文本内容（可能只能以图片发送）" };
  const match = (v: unknown) => (e.rawText && typeof v === "string" ? norm(v).includes(norm(e.rawText)) : null);
  if (Array.isArray(content.pages)) {
    const pages = content.pages.map(obj);
    if (e.page == null) return { found: false, reason: "来源没有页码，无法定位到页", pages_in_input: pages.map((p) => p.page) };
    const pg = pages.find((p) => p.page === e.page);
    if (!pg) return { found: false, reason: `构造输入里没有第 ${e.page} 页的文本`, pages_in_input: pages.map((p) => p.page) };
    const text = String(pg.text ?? "");
    const at = e.rawText ? text.indexOf(e.rawText) : -1;
    const piece = view === "page" ? clip(text) : clip(text, Math.max(0, at - 200), 800);
    return { found: true, kind: "PAGE_TEXT", page: e.page, raw_text_found_on_page: match(text), ...piece };
  }
  if (Array.isArray(content.sheets)) {
    const sheets = content.sheets.map(obj);
    const sh = sheets.find((s) => s.name === e.sheet) ?? (sheets.length === 1 && !e.sheet ? sheets[0] : undefined);
    if (!sh) return { found: false, reason: `构造输入里没有 Sheet「${e.sheet ?? "（未指明）"}」`, sheets_in_input: sheets.map((s) => s.name) };
    const cells = (Array.isArray(sh.cells) ? sh.cells : []).map(obj);
    if (view === "page") return { found: true, kind: "SHEET", sheet: sh.name, ...clip(JSON.stringify(cells)) };
    if (e.row == null) return { found: false, reason: "来源没有行号，无法定位单元格" };
    const rowCells = cells.filter((x) => x.row === e.row);
    const cell = e.column ? rowCells.find((x) => x.column === colNum(e.column!)) : undefined;
    return { found: !!rowCells.length, kind: "SHEET_CELL", sheet: sh.name, row: e.row, column: e.column, value_at_location: cell?.value ?? null, raw_text_matches: cell ? match(String(cell.value)) : null, row_cells: rowCells };
  }
  if (Array.isArray(content.rows)) {
    if (e.sheet && content.sheet && e.sheet !== content.sheet) return { found: false, reason: `输入里的 Sheet 是「${String(content.sheet)}」，不是「${e.sheet}」` };
    if (view === "page") return { found: true, kind: "SHEET", sheet: content.sheet ?? null, ...clip(JSON.stringify(content)) };
    if (e.row == null) return { found: false, reason: "来源没有行号，无法定位单元格" };
    const row = content.rows.map(obj).find((r) => r.row === e.row);
    const header = obj(content.header);
    const v = e.column ? (row?.[e.column.toUpperCase()] ?? header[`${e.column.toUpperCase()}${e.row}`]) : undefined;
    const value = obj(v).cached ?? v ?? null;
    return { found: row !== undefined || v !== undefined, kind: "SHEET_CELL", sheet: content.sheet ?? null, row: e.row, column: e.column, value_at_location: value, raw_text_matches: value === null ? null : match(String(value)), row_values: row ?? null, column_titles: content.columns ?? null };
  }
  return { found: false, reason: "无法识别这个文件在输入中的结构，不做猜测" };
}

/** 来源证据：必须是这个 Run 结果里登记过的来源（防止跨 Run / 任意路径读取） */
export function sourceEvidence(c: RunContext, sourceRef: string, view: "snippet" | "page" | "region") {
  const { run } = c;
  const e = run.view_model?.evidence.find((x) => x.id === sourceRef);
  if (!e) throw new BundleError("SOURCE_REF_NOT_IN_RUN", "这个 source_ref 不是该 Run 结果里登记的来源；只能读取本 Run 的来源", { hint: "先用 get_run_trace 的 object 部分拿到 evidence_refs" });
  if (view === "region") return { source_ref: sourceRef, view, supported: false, reason: "暂不支持按区域裁剪原件图像；请用 page_image 看整页，或用 snippet / page" };
  const mf = run.input_manifest?.files.find((f) => f.file_id === e.fileId);
  const material = c.snapshot?.materials.find((m) => m.file_id === e.fileId);
  let input: unknown;
  if (e.location === "REQUEST") {
    const ptr = e.id.replace(/^req:/, "");
    const hit = c.request ? getByPointer(c.request, ptr) : { found: false };
    input = hit.found ? { found: true, kind: "REQUEST_NODE", json_pointer: ptr, ...clip(JSON.stringify(hit.value, null, 1), 0, 4000) } : { found: false, reason: "构造输入里找不到这个位置" };
  } else input = c.request ? locateInInput(c.request, e, view) : { found: false, reason: "这条 Run 的构造输入不可用（没有副本，快照也不可用）" };
  return {
    source_ref: sourceRef,
    view,
    claimed_by_model: { file_id: e.fileId || null, file_name: e.fileName ?? null, page: e.page ?? null, sheet: e.sheet ?? null, row: e.row ?? null, column: e.column ?? null, raw_text: e.rawText ?? null, label: e.label ?? null, json_pointer: e.jsonPointer ?? null, location: e.location ?? null },
    availability: e.availability,
    input_origin: c.request_origin,
    input_at_location: input,
    input_coverage: fieldInputCoverage([e], run.input_manifest, run.mode)[0],
    file: e.fileId
      ? {
          file_id: e.fileId,
          sha256: mf?.original_file_hash ?? material?.content_hash ?? null,
          media_type: mf?.media_type ?? material?.media_type ?? null,
          total_pages: mf?.total_pages ?? null,
          image_pages_sent: mf?.image_pages_sent ?? null,
          image_ref: run.attached_images?.filter((i) => i.file_id === e.fileId && (e.page == null || i.page === e.page)) ?? null,
          preview_path: `/api/materials/${encodeURIComponent(e.fileId)}/preview`,
          preview_note: "原件预览在 Prompt Studio 网页内打开（同样有授权检查）；MCP 不返回任意文件路径",
        }
      : null,
  };
}

/** 这次运行输入里真实存在的文件（清单、快照材料、构造输入），用于决定能否打开原件 */
export function runFileIds(c: RunContext): Set<string> {
  const input = obj(obj(c.request).input);
  const fromRequest = [...(Array.isArray(input.materials) ? input.materials : []), ...(Array.isArray(input.files) ? input.files : [])].map((x) => obj(x).file_id);
  return new Set([...(c.run.input_manifest?.files.map((f) => f.file_id) ?? []), ...(c.snapshot?.materials.map((m) => m.file_id) ?? []), ...fromRequest].filter((x): x is string => typeof x === "string"));
}

/**
 * 原件核对：在 snippet 的基础上打开原件，读来源指向的单元格 / 页，并与构造输入、模型声称的原文对照。
 * 只打开这次运行输入里确实有的文件——模型声称的 file_id 可能是编造的，不能据此读别的文件。
 */
export async function sourceEvidenceOriginal(c: RunContext, sourceRef: string) {
  const base = sourceEvidence(c, sourceRef, "snippet");
  const e = c.run.view_model!.evidence.find((x) => x.id === sourceRef)!;
  const withOriginal = (original: unknown) => ({ ...base, view: "original" as const, original });
  if (!e.fileId) return withOriginal({ found: false, reason: "这条来源在请求数据里，不对应原件" });
  if (!runFileIds(c).has(e.fileId)) return withOriginal({ found: false, reason: "模型声称的文件不在这次运行的输入里，不打开（可能是模型编造的 file_id）" });
  try {
    const r = await readOriginalAt(e.fileId, { page: e.page, sheet: e.sheet, row: e.row, column: e.column, rawText: e.rawText }, base.file?.sha256 ?? null);
    const orig = r.original_at_location as { value_at_location?: string | null; raw_value?: unknown };
    const inputValue = (base.input_at_location as { value_at_location?: unknown }).value_at_location;
    // 显示文本或底层值任一与输入相同即视为一致（数字单元格的显示文本带千分位等格式）
    const sameAsInput = (v: unknown) => [orig.value_at_location, orig.raw_value].some((o) => o !== null && o !== undefined && String(o).trim() === String(v).trim());
    return withOriginal({
      ...r,
      comparison:
        orig.value_at_location !== undefined
          ? {
              original_equals_input: inputValue === undefined || inputValue === null ? null : sameAsInput(inputValue),
              original_matches_model_raw_text: (r.original_at_location as { raw_text_matches?: boolean | null }).raw_text_matches ?? null,
            }
          : null,
    });
  } catch (err) {
    return withOriginal({ found: false, reason: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null });
  }
}

/** 页面图片的大小上限（原始字节）；超过就不返回，避免 Agent 客户端拒收 */
export const MAX_PAGE_IMAGE_BYTES = 3_500_000;

/**
 * 原件页面图片（扫描件没有文字层时，让 Agent 自己看图核对）：来源所在页渲染成 JPEG（长边 1600px）。
 * 与 view=original 同样的限制：source_ref 必须属于该 Run，文件必须在这次运行的输入里；同时核对原件 Hash。
 * 返回的 _images 由 MCP 层转成图片内容块，不进 JSON 文本。
 */
export async function sourcePageImage(c: RunContext, sourceRef: string) {
  const base = sourceEvidence(c, sourceRef, "snippet");
  const e = c.run.view_model!.evidence.find((x) => x.id === sourceRef)!;
  const out = (page_image: Record<string, unknown>, images: { media_type: string; base64: string }[] = []) => ({ ...base, view: "page_image" as const, page_image, _images: images });
  if (!e.fileId) return out({ found: false, reason: "这条来源在请求数据里，不对应原件" });
  if (!runFileIds(c).has(e.fileId)) return out({ found: false, reason: "模型声称的文件不在这次运行的输入里，不打开（可能是模型编造的 file_id）" });
  let f: Awaited<ReturnType<typeof resolveMaterialFile>>;
  try {
    f = await resolveMaterialFile(e.fileId);
  } catch (err) {
    return out({ found: false, reason: `无法读取原件：${err instanceof Error ? err.message : String(err)}` });
  }
  const buf = await readFile(f.absolutePath);
  const bytesHash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const recorded = base.file?.sha256 ?? null;
  const fileHash = bytesHash(buf);
  const fileInfo = { file_id: e.fileId, file_name: f.fileName, media_type: f.mediaType, sha256: fileHash, recorded_sha256: recorded, hash_matches_record: recorded ? fileHash === recorded : null };
  let img: Buffer | null;
  let page: number | null = null;
  let media = "image/jpeg";
  if (f.mediaType === "application/pdf") {
    if (!e.page) return out({ found: false, file: fileInfo, reason: "这条来源没有页码，无法确定要看哪一页" });
    const total = await pdfPageCount(f.absolutePath);
    if (total !== null && e.page > total) return out({ found: false, file: fileInfo, reason: `原件只有 ${total} 页，来源指向第 ${e.page} 页` });
    page = e.page;
    img = await renderPdfPage(f.absolutePath, e.page);
    if (!img) return out({ found: false, file: fileInfo, reason: `第 ${e.page} 页转图失败` });
  } else if (f.mediaType.startsWith("image/")) {
    img = buf;
    media = f.mediaType;
  } else return out({ found: false, file: fileInfo, reason: "原件不是 PDF 或图片；表格请用 view=original 按单元格核对" });
  if (img.length > MAX_PAGE_IMAGE_BYTES) return out({ found: false, file: fileInfo, reason: `图片有 ${img.length} 字节，超过上限 ${MAX_PAGE_IMAGE_BYTES}` });
  return out(
    { found: true, file: fileInfo, page, media_type: media, image_bytes: img.length, image_sha256: bytesHash(img), note: "图片是原件这一页的渲染，随本结果作为图片内容返回；模型声称的原文与位置见 claimed_by_model" },
    [{ media_type: media, base64: img.toString("base64") }],
  );
}

/** 提示词里的章节标题（Markdown 标题、【】、编号行），给出行号便于引用 */
function sections(text: string) {
  return text
    .split("\n")
    .map((line, i) => ({ line: i + 1, title: line.trim() }))
    .filter((x) => /^(#{1,6}\s|【|\d+(\.\d+)*[.、]\s?\S|[一二三四五六七八九十]+、)/.test(x.title) && x.title.length <= 80)
    .slice(0, 120);
}

export type PromptPart = "system" | "user" | "user_template";

/** 当次真实执行的提示词（按 Run），或某个已保存版本（按版本） */
export function promptSnapshot(src: { run?: Run; version?: PromptVersion }, include: PromptPart[], offset = 0) {
  if (src.run) {
    const r = src.run;
    const texts: Record<PromptPart, string | undefined> = { system: r.actual_prompt?.system, user: r.actual_prompt?.user, user_template: r.prompt_source?.user_template };
    return {
      source: "RUN_ACTUAL",
      run_id: r.run_id,
      prompt_version_id: r.prompt_version_id ?? null,
      prompt_version_label: r.prompt_version_id ? (getVersion(r.prompt_version_id)?.label ?? null) : null,
      is_unsaved_draft: r.is_unsaved_draft,
      actual_prompt_hash: r.actual_prompt_hash ?? null,
      available: !!r.actual_prompt,
      reason: r.actual_prompt ? null : r.mode === "MODEL_RUN" ? "这条 Run 没有保存实际提示词" : "没有调用模型（仅渲染 / 回放），没有实际提示词",
      system_template_differs_from_actual: r.prompt_source && r.actual_prompt ? r.prompt_source.system !== r.actual_prompt.system : null,
      lengths: Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v?.length ?? null])),
      system_sections: r.actual_prompt ? sections(r.actual_prompt.system) : [],
      parts: Object.fromEntries(include.map((k) => [k, texts[k] === undefined ? null : clip(texts[k]!, offset)])),
    };
  }
  const v = src.version!;
  const texts: Record<PromptPart, string | undefined> = { system: v.system_prompt, user: undefined, user_template: v.user_prompt_template };
  return {
    source: "SAVED_VERSION",
    prompt_version_id: v.version_id,
    prompt_id: v.prompt_id,
    label: v.label,
    content_hash: v.content_hash,
    parent_version_id: v.parent_version_id,
    created_at: v.created_at,
    change_note: v.change_note ?? null,
    note: "这是已保存的版本内容；某次运行实际发送了什么，请按 run_id 读取",
    system_sections: sections(v.system_prompt),
    parts: Object.fromEntries(include.map((k) => [k, texts[k] === undefined ? null : clip(texts[k]!, offset)])),
  };
}

/** 人工标注（含修订历史）；可按对象过滤。标注是人工判断，不等于 Gold */
export function runAnnotations(c: RunContext, objectRef?: ObjectRef) {
  let list = listAnnotations(c.run.run_id);
  let scope: string | null = null;
  if (objectRef) {
    const o = resolveObject(c.run, objectRef);
    scope = o.json_pointer;
    list = list.filter((a) => a.target_json_pointer && (isWithin(a.target_json_pointer, o.json_pointer) || isWithin(o.json_pointer, a.target_json_pointer)));
  }
  return {
    run_id: c.run.run_id,
    scope_json_pointer: scope,
    count: list.length,
    annotations: list,
    gold: { available: false, note: "Studio 目前没有版本化 Gold；标注是人工判断，Agent 的推测不得当作标注或 Gold" },
  };
}

/** 评测：没有字段级 Gold 时如实返回未评测，只给确定性的 Gold 行数核对（若样本带有） */
export function runEvaluation(c: RunContext) {
  const { run } = c;
  const anns = listAnnotations(run.run_id);
  const goldDiags = [...(run.view_model?.diagnostics ?? []), ...(run.adapter_diagnostics ?? [])].filter((d) => /GOLD/i.test(d.code));
  return {
    run_id: run.run_id,
    status: "EVAL_NOT_AVAILABLE",
    gold_version: null,
    reason: c.has_gold ? "样本只带有行数一类的 Gold 提示，没有字段级标准答案，不计算准确率" : "没有标准答案（Gold），不计算准确率",
    gold_row_count_checks: goldDiags,
    human_annotation_counts: {
      wrong: anns.filter((a) => a.assessment === "WRONG").length,
      correct: anns.filter((a) => a.assessment === "CORRECT").length,
      unsure: anns.filter((a) => a.assessment === "UNSURE").length,
      note: "人工标注计数不是准确率",
    },
  };
}

/** 两次 Run 的业务差异、输入可比性与用量差异 */
export function runComparison(a: RunContext, b: RunContext, limit = 100) {
  const cmp = compareRuns(a.run, b.run);
  const diff = diffSummary(a.run.parsed_json ?? null, b.run.parsed_json ?? null);
  const hunkLines = (h: typeof cmp.system) => (h ? h.map((x) => ({ old_start: x.oldStart, new_start: x.newStart, lines: x.lines.slice(0, 80) })) : null);
  return {
    base_run_id: a.run.run_id,
    candidate_run_id: b.run.run_id,
    input_comparability: cmp.input,
    strict_same_conditions: cmp.strict,
    metrics: cmp.metrics,
    business_diff: { total: diff.rows.length, same_leaves: diff.same, rows: diff.rows.slice(0, limit), truncated: diff.rows.length > limit },
    prompt_diff: { system: hunkLines(cmp.system), user_changed_hunks: cmp.user?.length ?? null },
    cost: { note: "服务商不返回价格；只能比较 Token 与耗时", token_usage: [a.run.token_usage ?? null, b.run.token_usage ?? null], latency_ms: [a.run.latency_ms ?? null, b.run.latency_ms ?? null] },
    note: cmp.input.comparable ? "输入可比；差异仍不等于准确率变化（没有 Gold）" : "输入不可直接比较：差异不能当作提示词改进或退化的依据",
  };
}
