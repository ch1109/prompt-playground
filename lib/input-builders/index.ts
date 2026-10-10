import { PROMPT_KINDS, type PromptKind } from "@/lib/contracts/run";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { FIELD_LABELS } from "@/lib/schemas/common";

// 从快照显式构造 P1~P4 请求（v3 外层：schema_version / prompt / request_id / context / input）。
// 构造是纯函数，只使用快照中的数据，不隐式拉取业务数据。

// 1.1.0：P1 按单证分段纳入发票 / 箱单辅助材料；1.2.0：支持上传文件快照（P1/P2）
export const INPUT_BUILDER_VERSION = "1.3.0";

export type BuildResult =
  | { ok: true; request: Record<string, unknown>; builderId: string; warnings: string[]; requiresFiles: string[] }
  | { ok: false; code: string; message: string };

type Rec = Record<string, unknown>;
const PCODE: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4" };
const CN_TO_KEY: Record<string, string> = Object.fromEntries(Object.entries(FIELD_LABELS).map(([k, v]) => [v, k]));
/** Demo 用 "UNKNOWN" 作缺失占位；按 v3 契约转为空字符串（构造规则，已版本化） */
/** 九立 Demo 单证分段 kind → P1 material_type；其他种类不属于 P1 材料 */
const P1_MATERIAL_TYPE: Record<string, string> = { invoice: "INVOICE", "packing-list": "PACKING_LIST" };
const val = (v: unknown) => (v === undefined || v === null || v === "UNKNOWN" ? "" : String(v));

function envelope(kind: PromptKind, snapshot: InputSnapshot, context: Rec, input: Rec) {
  return {
    schema_version: "jiuli-ai-v3",
    prompt: PCODE[kind],
    request_id: `STUDIO-${snapshot.snapshot_id}-${PCODE[kind]}`,
    context,
    input,
  };
}

function identityFromFields(fields: Record<string, string>) {
  const id: Record<string, string> = {};
  for (const [cn, v] of Object.entries(fields)) {
    const k = CN_TO_KEY[cn] ?? { 产地: "origin" }[cn];
    if (k && ["model", "brand", "origin", "quantity", "unit", "material_no", "purchase_order_no", "sku"].includes(k)) id[k] = val(v);
  }
  return id;
}

export function buildInput(kind: PromptKind, snapshot: InputSnapshot): BuildResult {
  const payload = snapshot.normalized_payload as Rec;

  // 1) 快照自带对应阶段的请求（录制样本 / 手动导入）：原样使用
  const requests = (payload.requests as Rec | undefined) ?? {};
  const recorded = (requests[kind] ?? (payload.request_kind === kind ? payload.request : undefined)) as Rec | undefined;
  if (recorded) return { ok: true, request: recorded, builderId: "passthrough-snapshot-request", warnings: [], requiresFiles: [] };

  if (kind === "GENERIC_JSON") {
    if (snapshot.source_type === "FILE_IMPORT") return buildFromUpload(kind, snapshot);
    return { ok: true, request: payload, builderId: "generic-snapshot-payload", warnings: [], requiresFiles: [] };
  }

  if (snapshot.source_type === "FILE_IMPORT") return buildFromUpload(kind, snapshot);

  if (snapshot.source_type !== "JIULI_READONLY") {
    return { ok: false, code: "NO_INPUT_FOR_KIND", message: `该快照没有可用于 ${PCODE[kind]} 的请求数据。请导入对应阶段的 request JSON，或从九立只读导入。` };
  }

  const customer = payload.customer as Rec;
  const task = payload.task as Rec | undefined;
  const lines = (payload.lines as Rec[]) ?? [];
  const insp = (payload.inspections as { batches: Rec[]; sourceLines: Rec[]; groups: Rec[] }) ?? { batches: [], sourceLines: [], groups: [] };
  const extracted = (payload.extracted as Rec) ?? {};
  const warnings: string[] = [];

  const fileContent = (fileId: string) => extracted[fileId];
  const missingText = (ids: string[]) => ids.filter((id) => fileContent(id) === undefined);

  switch (kind) {
    case "JIULI_P1": {
      if (!task) return { ok: false, code: "NO_TASK", message: "快照中没有委托任务，无法构造 P1 输入" };
      const mainId = String(task.fileId);
      const supporting = ((task.supportingFileIds as string[]) ?? []).map(String);
      const segInfo = (payload.materialSegments as Record<string, { segments?: { kind: string; pages: number[] }[]; same_document_as?: string | null }> | undefined) ?? {};
      const materials: { file_id: string; material_type: string; segments: string[]; content: unknown }[] = [
        { file_id: mainId, material_type: "ORDER", segments: [], content: fileContent(mainId) ?? null },
      ];
      const included = new Set<string>();
      for (const id of supporting) {
        const info = segInfo[id];
        if (info?.same_document_as === mainId) {
          warnings.push(`辅助材料 ${id} 与主委托文件为同一单证，未重复纳入`);
          continue;
        }
        const usable = (info?.segments ?? []).filter((s) => P1_MATERIAL_TYPE[s.kind] && s.pages.length);
        const other = (info?.segments ?? []).filter((s) => !P1_MATERIAL_TYPE[s.kind]).map((s) => s.kind);
        if (other.length) warnings.push(`辅助材料 ${id} 含 ${[...new Set(other)].join("/")}，不属于 P1 材料类型（ORDER/INVOICE/PACKING_LIST），该部分未纳入`);
        if (!usable.length) {
          if (!other.length) warnings.push(`辅助材料 ${id} 的单证类型（发票/箱单）在 Demo 数据中未标明，未纳入请求`);
          continue;
        }
        // 同一文件含发票页与箱单页时按页拆成多条材料，内容只保留对应页（预处理文本按页存放时）
        const content = fileContent(id) as { pages?: { page: number }[] } | undefined;
        for (const s of usable) {
          materials.push({
            file_id: id,
            material_type: P1_MATERIAL_TYPE[s.kind],
            segments: s.pages.map((p) => `page:${p}`),
            content: content && Array.isArray(content.pages) ? { ...content, pages: content.pages.filter((p) => s.pages.includes(p.page)) } : (content ?? null),
          });
        }
        included.add(id);
      }
      return {
        ok: true,
        builderId: "jiuli-demo-p1",
        warnings,
        requiresFiles: missingText([mainId, ...included]),
        request: envelope(kind, snapshot, { customer_directory: [{ customer_id: customer.customer_id, customer_name: customer.name, aliases: customer.aliases ?? [] }], normalization: {} }, { materials }),
      };
    }
    case "JIULI_P2": {
      const fileIds = [...new Set(insp.batches.map((b) => String(b.fileId)).filter(Boolean))];
      if (!fileIds.length) return { ok: false, code: "NO_INSPECTION", message: "快照中没有查货批次，无法构造 P2 输入" };
      return {
        ok: true,
        builderId: "jiuli-demo-p2",
        warnings,
        requiresFiles: missingText(fileIds),
        request: envelope(kind, snapshot, { customer_id: customer.customer_id, normalization: {} }, { files: fileIds.map((id) => ({ file_id: id, segments: [], content: fileContent(id) ?? null })) }),
      };
    }
    case "JIULI_P3": {
      if (!task || !lines.length) return { ok: false, code: "NO_TASK", message: "快照中没有委托行，无法构造 P3 输入" };
      if (!insp.sourceLines.length) return { ok: false, code: "NO_INSPECTION", message: "快照中没有查货原始行，无法构造 P3 输入" };
      const groupOf = new Map<string, string>();
      insp.groups.forEach((g) => ((g.sourceLineIds as string[]) ?? []).forEach((id) => groupOf.set(id, String(g.id))));
      const orderOf = new Map(insp.batches.map((b) => [String(b.id), b]));
      const order_rows = lines.map((l) => {
        const fields = (l.fields as Record<string, string>) ?? {};
        const src = (l.source as Rec) ?? {};
        return {
          order_row_id: String(l.id),
          customer_id: String(l.customerId),
          identity: identityFromFields(fields),
          evidence: Object.entries(identityFromFields(fields))
            .filter(([, v]) => v !== "")
            .map(([k, v]) => ({ evidence_key: `E-O-${String(l.id)}-${k}`, field: k, value: v, source: { file_id: src.fileId ?? "", page: src.page ?? null, sheet: src.sheet ?? null, row: src.row ?? null, column: null, raw_text: v } })),
        };
      });
      const inspection_candidates = insp.sourceLines.map((s) => {
        const fields = (s.fields as Record<string, string>) ?? {};
        const src = (s.source as Rec) ?? {};
        const ord = orderOf.get(String(s.inspectionOrderId));
        return {
          raw_row_id: String(s.id),
          customer_id: String(s.customerId),
          logical_inspection_id: String(s.inspectionOrderId),
          warehouse_no: val(ord?.warehouseNo),
          merged_product_id: groupOf.get(String(s.id)) ?? null,
          identity: identityFromFields(fields),
          // Studio 无法证明范围完整性，如实标为 UNCERTAIN
          scope_summary: { coverage: "UNCERTAIN", overlap: "UNKNOWN", has_extra_goods: false, has_unresolved_goods: false },
          evidence: Object.entries(identityFromFields(fields))
            .filter(([, v]) => v !== "")
            .map(([k, v]) => ({ evidence_key: `E-I-${String(s.id)}-${k}`, field: k, value: v, source: { file_id: src.fileId ?? "", page: src.page ?? null, sheet: null, row: null, column: null, raw_text: v } })),
          occupied_by_order_row_id: (s.occupation as string | null) ?? null,
        };
      });
      warnings.push("retrieval_complete=false：Studio 快照无法证明候选召回完整");
      return {
        ok: true,
        builderId: "jiuli-demo-p3",
        warnings,
        requiresFiles: [],
        request: envelope(kind, snapshot, { customer_id: customer.customer_id, retrieval_complete: false }, { order_rows, inspection_candidates, proposed_groups: [], comparison_results: [] }),
      };
    }
    case "JIULI_P4": {
      const relations = (payload.relations as Rec[]) ?? [];
      if (!relations.length) {
        return { ok: false, code: "NO_MATCHED_RELATION", message: "P4 只核验已确定的 MATCHED 关系；快照中没有关系数据。请使用含 P4 request 的样本，或在九立确定关系后重新导入。" };
      }
      return { ok: false, code: "UNSUPPORTED", message: "九立 Demo 关系数据结构尚未确认，未实现 P4 构造器（不做猜测）。" };
    }
  }
  return { ok: false, code: "UNKNOWN_KIND", message: `未知 Prompt 种类 ${kind}` };
}

interface UploadMeta {
  file_id: string;
  file_name: string;
  material_type: string;
  media_type: string;
  segments: string[];
  has_text: boolean;
}

/** 上传文件快照 → 通用提示词（全部文件）、P1（委托/发票/箱单）或 P2（查货文件）输入；P3/P4 需要上游结构化结果，不能由原始文件构造 */
function buildFromUpload(kind: PromptKind, snapshot: InputSnapshot): BuildResult {
  const payload = snapshot.normalized_payload as Rec;
  const fi = (payload.file_import as { customer_name: string | null; materials: UploadMeta[] } | undefined) ?? { customer_name: null, materials: [] };
  const extracted = (payload.extracted as Rec) ?? {};
  const warnings: string[] = [];
  const customerId = fi.customer_name ? "UPLOAD-CUSTOMER" : "";
  const noText = (ms: UploadMeta[]) => [...new Set(ms.filter((m) => !m.has_text).map((m) => m.file_id))];
  if (kind === "JIULI_P1") {
    const ms = fi.materials.filter((m) => ["ORDER", "INVOICE", "PACKING_LIST"].includes(m.material_type));
    if (!ms.some((m) => m.material_type === "ORDER")) return { ok: false, code: "NO_ORDER_FILE", message: "上传的文件中没有标为「委托单」的材料，无法构造 P1 输入" };
    if (!fi.customer_name) warnings.push("上传时未填写客户名称：P1 的客户目录为空，模型无法匹配客户");
    return {
      ok: true,
      builderId: "file-import-p1",
      warnings,
      requiresFiles: noText(ms),
      request: envelope(
        kind,
        snapshot,
        { customer_directory: fi.customer_name ? [{ customer_id: customerId, customer_name: fi.customer_name, aliases: [] }] : [], normalization: {} },
        { materials: ms.map((m) => ({ file_id: m.file_id, material_type: m.material_type, segments: m.segments, content: extracted[m.file_id] ?? null })) },
      ),
    };
  }
  if (kind === "JIULI_P2") {
    const ms = fi.materials.filter((m) => m.material_type === "INSPECTION");
    if (!ms.length) return { ok: false, code: "NO_INSPECTION", message: "上传的文件中没有标为「查货文件」的材料，无法构造 P2 输入" };
    if (!fi.customer_name) warnings.push("上传时未填写客户名称：P2 的 customer_id 为空");
    return {
      ok: true,
      builderId: "file-import-p2",
      warnings,
      requiresFiles: noText(ms),
      request: envelope(kind, snapshot, { customer_id: customerId, normalization: {} }, { files: ms.map((m) => ({ file_id: m.file_id, segments: m.segments, content: extracted[m.file_id] ?? null })) }),
    };
  }
  if (kind === "GENERIC_JSON") {
    // 通用提示词：所有文件原样列出（不分材料类型），放在 input.files 下，附带原件图片时据此找到原件
    return {
      ok: true,
      builderId: "file-import-generic",
      warnings,
      requiresFiles: noText(fi.materials),
      request: { input: { files: fi.materials.map((m) => ({ file_id: m.file_id, file_name: m.file_name, media_type: m.media_type, content: extracted[m.file_id] ?? null })) } },
    };
  }
  return { ok: false, code: "NO_INPUT_FOR_KIND", message: `${PCODE[kind]} 需要上游结构化结果（委托行、查货行或已确定关系），不能直接由上传的原始文件构造` };
}

/** 该快照能构造出输入的 Prompt 种类（用于快照列表按当前 Prompt 过滤） */
export function usableKinds(snapshot: InputSnapshot): PromptKind[] {
  return PROMPT_KINDS.filter((k) => buildInput(k, snapshot).ok);
}

/** 模板里登记的变量；其余 {{...}} 都视为悬空变量 */
export const TEMPLATE_VARIABLES = ["input_json"];

/** 模板（system 与 user）中没有登记、展开后仍会原样发出的 {{变量}} */
export function unresolvedVariables(...templates: string[]): string[] {
  const found = new Set<string>();
  for (const t of templates) for (const m of t.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) if (!TEMPLATE_VARIABLES.includes(m[1])) found.add(m[0]);
  return [...found];
}

/** 展开用户模板：只替换登记的变量 */
export function renderUserTemplate(template: string, request: unknown): string {
  return template.split("{{input_json}}").join(JSON.stringify(request, null, 2));
}
