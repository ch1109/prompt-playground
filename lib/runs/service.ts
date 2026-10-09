import { findAdapterById } from "@/lib/adapters/registry";
import type { AdapterContext, MaterialAccess } from "@/lib/adapters/types";
import type { ModelParams, PipelineResult, PromptKind, Run, RunMode } from "@/lib/contracts/run";
import type { Diagnostic } from "@/lib/contracts/view-model";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { newId, sha256, stableStringify } from "@/lib/hash";
import { buildInput, INPUT_BUILDER_VERSION, renderUserTemplate } from "@/lib/input-builders";
import { getProvider, redactSecrets } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { findRendererConfig } from "@/lib/renderer-config/registry";
import { contentHash, getPrompt, getVersion } from "@/lib/repositories/prompts";
import { finishRun, getRun, saveRun, startRun } from "@/lib/repositories/runs";
import { getSnapshot, snapshotDeletedAt } from "@/lib/repositories/snapshots";
import { materialInfo } from "@/lib/materials/store";
import { buildPageImages, referencedFileIds } from "./page-images";

export class RunServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
  }
}

/** 由快照构造 Adapter 上下文（请求、材料授权、Gold、基准草稿），全部来自快照，不拉新数据 */
export function contextFromSnapshot(runId: string, kind: PromptKind, snapshot?: InputSnapshot): AdapterContext {
  if (!snapshot) return { runId };
  const payload = snapshot.normalized_payload as Record<string, unknown>;
  const requests = (payload.requests as Record<string, unknown> | undefined) ?? {};
  const materials: Record<string, MaterialAccess> = {};
  for (const m of snapshot.materials) materials[m.file_id] = { availability: m.availability, fileName: m.file_name };
  let request = requests[kind] ?? (payload.request_kind === kind ? payload.request : undefined);
  if (!request && snapshot.source_type === "JIULI_READONLY") {
    const built = buildInput(kind, snapshot);
    if (built.ok) request = built.request;
  }
  return {
    runId,
    request,
    materials: Object.keys(materials).length ? materials : undefined,
    gold: payload.gold as AdapterContext["gold"],
    baseDraft: payload.baseDraft as AdapterContext["baseDraft"],
  };
}

function versionsOf(result: PipelineResult) {
  return {
    schema_id: result.validation.schemaId ?? null,
    schema_version: result.validation.schemaVersion ?? null,
    adapter_id: result.adapterId ?? null,
    adapter_version: result.adapterVersion ?? null,
    renderer_config_version: result.rendererConfigVersion ?? null,
  };
}

function diagByPhase(result: PipelineResult) {
  return {
    parse_diagnostics: result.diagnostics.filter((d) => d.phase === "PARSE"),
    schema_diagnostics: result.diagnostics.filter((d) => d.phase === "SCHEMA"),
  };
}

interface Base {
  projectId: string;
  promptId: string;
  label?: string;
  snapshotId?: string | null;
}

function loadPrompt(promptId: string) {
  const p = getPrompt(promptId);
  if (!p) throw new RunServiceError("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
  return p;
}

function loadSnapshot(id?: string | null) {
  if (!id) return undefined;
  const s = getSnapshot(id);
  if (!s) {
    const deletedAt = snapshotDeletedAt(id);
    if (deletedAt) throw new RunServiceError("SNAPSHOT_DELETED", `快照 ${id} 已删除或到期（${deletedAt.slice(0, 19).replace("T", " ")}），无法再使用当时的输入`, 410);
    throw new RunServiceError("SNAPSHOT_NOT_FOUND", "快照不存在", 404);
  }
  return s;
}

/** RENDER_ONLY：导入原始 JSON，直接进入解析、校验与渲染，不调用模型 */
export function renderOnly(input: Base & { raw: string }): Run {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId);
  const runId = newId("run");
  const started = new Date().toISOString();
  const result = runPipeline({ raw: input.raw, promptKind: prompt.prompt_kind, context: contextFromSnapshot(runId, prompt.prompt_kind, snapshot) });
  const run: Run & { label?: string } = {
    run_id: runId,
    project_id: input.projectId,
    prompt_id: prompt.prompt_id,
    prompt_kind: prompt.prompt_kind,
    prompt_version_id: null,
    is_unsaved_draft: false,
    input_snapshot_id: snapshot?.snapshot_id ?? null,
    mode: "RENDER_ONLY",
    model_provider: null,
    model_name: null,
    provider_adapter_version: null,
    model_params: null,
    actual_prompt_hash: null,
    built_input_hash: null,
    actual_prompt: null,
    ...versionsOf(result),
    started_at: started,
    ended_at: new Date().toISOString(),
    status: result.status,
    raw_response: input.raw,
    raw_response_hash: sha256(input.raw),
    parsed_json: result.parse.value,
    ...diagByPhase(result),
    view_model: result.viewModel ?? null,
    token_usage: null,
    latency_ms: null,
    estimated_cost: null,
    error: null,
    label: input.label ?? "仅渲染",
  };
  return saveRun(run);
}

/**
 * 没有预处理文本、且无法以其他方式交给模型的材料（运行时会被阻断）。
 * 开启「附带原件图片」时，PDF / 图片会作为页面图片发送，不再阻断；Excel 等无法转图的仍阻断。
 */
function blockedFiles(requiresFiles: string[], snapshot: InputSnapshot, attachImages?: boolean): string[] {
  if (!attachImages) return requiresFiles;
  const media = new Map(snapshot.materials.map((m) => [m.file_id, m.media_type ?? ""]));
  return requiresFiles.filter((id) => !(media.get(id) === "application/pdf" || media.get(id)?.startsWith("image/")));
}

/** 运行前预览：实际发送的系统提示词、用户消息与构造输入 */
export async function previewModelRun(input: { promptId: string; snapshotId: string; system: string; userTemplate: string; attachImages?: boolean }) {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId)!;
  const built = buildInput(prompt.prompt_kind, snapshot);
  const info = getProvider().info();
  if (!built.ok) return { ok: false as const, code: built.code, message: built.message, provider: info };
  const user = renderUserTemplate(input.userTemplate, built.request);
  // 只列出将附带的原件，不在预览时转换 PDF
  const ids = input.attachImages ? referencedFileIds(built.request) : [];
  const attachFiles = ids.length ? await materialInfo(ids) : [];
  return {
    ok: true as const,
    attachFiles: input.attachImages ? attachFiles : null,
    provider: info,
    builderId: built.builderId,
    warnings: built.warnings,
    requiresFiles: blockedFiles(built.requiresFiles, snapshot, input.attachImages),
    request: built.request,
    system: input.system,
    user,
    actualPromptHash: contentHash(input.system, user),
    builtInputHash: sha256(stableStringify(built.request)),
  };
}

type ModelRunInput = Base & { snapshotId: string; system: string; userTemplate: string; promptVersionId?: string | null; params: ModelParams; attachImages?: boolean };

/** MODEL_RUN：服务端代理真实模型调用；失败保存失败 Run，绝不回退为 Mock */
export async function modelRun(input: ModelRunInput): Promise<Run> {
  return startModelRun(input).done;
}

/**
 * 登记 RUNNING Run 后立即返回 runId，模型调用在后台继续（done 结束时 Run 已落到终态）。
 * 浏览器拿到 runId 即可轮询，刷新或关闭页面也不会丢失这次运行。
 * 开始前就能发现的问题（未配置、输入无法构造、文件格式不支持）直接抛错，不留下 RUNNING 记录。
 */
export function startModelRun(input: ModelRunInput): { runId: string; done: Promise<Run> } {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId)!;
  const provider = getProvider();
  const info = provider.info();
  if (!info.configured) throw new RunServiceError("MODEL_NOT_CONFIGURED", "未配置模型（.env.local 中的 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY）", 400);

  const built = buildInput(prompt.prompt_kind, snapshot);
  if (!built.ok) throw new RunServiceError(built.code, built.message, 400);
  // AT27：模型不支持文件且材料没有预处理文本 → 明确阻断，不会只发文件名
  const blocked = blockedFiles(built.requiresFiles, snapshot, input.attachImages);
  if (blocked.length && !info.supportsFileInput) {
    throw new RunServiceError(
      "FILE_INPUT_UNSUPPORTED",
      `当前模型（${info.provider}）只接收文本，材料 ${blocked.join(", ")} 没有预处理文本。PDF / 图片可在「模型」页勾选「附带原件图片」后用视觉模型运行；其他格式请先生成预处理文本，或配置支持文件输入的模型。`,
      400,
    );
  }

  const version = input.promptVersionId ? getVersion(input.promptVersionId) : undefined;
  const isDraft = !version || version.content_hash !== contentHash(input.system, input.userTemplate);
  const user = renderUserTemplate(input.userTemplate, built.request);
  const runId = newId("run");
  const started = new Date().toISOString();

  const common = {
    run_id: runId,
    project_id: input.projectId,
    prompt_id: prompt.prompt_id,
    prompt_kind: prompt.prompt_kind,
    prompt_version_id: version?.version_id ?? null,
    is_unsaved_draft: isDraft,
    input_snapshot_id: snapshot.snapshot_id,
    mode: "MODEL_RUN" as RunMode,
    model_provider: info.provider,
    model_name: info.model,
    provider_adapter_version: info.adapterVersion,
    model_params: input.params,
    actual_prompt_hash: contentHash(input.system, user),
    built_input_hash: sha256(stableStringify(built.request)),
    attached_images: null as Run["attached_images"],
    actual_prompt: { system: redactSecrets(input.system), user: redactSecrets(user) },
    started_at: started,
    estimated_cost: null,
    label: input.label ?? `${info.model} 运行`,
    input_builder_id: `${built.builderId}@${INPUT_BUILDER_VERSION}`,
    input_builder_warnings: built.warnings,
  };
  const noResult = { schema_id: null, schema_version: null, adapter_id: null, adapter_version: null, renderer_config_version: null, parse_diagnostics: [], schema_diagnostics: [], view_model: null, token_usage: null };

  // 先登记 RUNNING：调用期间历史中可见；进程中断时启动会标为 INTERRUPTED
  startRun({ ...common, ...noResult, status: "RUNNING", ended_at: null, latency_ms: null, raw_response: "", raw_response_hash: "", error: null });

  const request = built.request;
  const builderWarnings = built.warnings;
  return { runId, done: finishModelRun() };

  async function finishModelRun(): Promise<Run> {
    try {
      const pages = input.attachImages ? await buildPageImages(referencedFileIds(request)) : null;
      const images = pages?.images.map((i) => ({ mediaType: i.media_type, base64: i.base64 }));
      const result = await provider.complete({ system: input.system, user, params: input.params, images });
      const done = {
        ...common,
        // 附带图片时，图片 hash 也计入实际提示词 hash
        actual_prompt_hash: pages?.images.length ? contentHash(input.system, `${user}\n${pages.images.map((i) => i.sha256).join(",")}`) : common.actual_prompt_hash,
        attached_images: pages ? pages.images.map(({ base64: _b, ...m }) => m) : null,
        input_builder_warnings: [...builderWarnings, ...(pages?.warnings ?? [])],
        ended_at: new Date().toISOString(),
        latency_ms: result.latencyMs,
      };

      if (!result.ok) {
        const raw = result.partialRaw ?? "";
        return finishRun({ ...done, ...noResult, status: "MODEL_ERROR", raw_response: raw, raw_response_hash: sha256(raw), error: { code: result.code, message: result.message } });
      }

      const finishReason = typeof result.responseMeta.finish_reason === "string" ? result.responseMeta.finish_reason : null;
      const pr = runPipeline({ raw: result.raw, promptKind: prompt.prompt_kind, context: { ...contextFromSnapshot(runId, prompt.prompt_kind, snapshot), request: request } });
      // 达到 max_tokens 被截断：单独说明原因，避免只看到"JSON 解析失败"
      const truncated: Diagnostic[] =
        finishReason === "length"
          ? [{ phase: "PARSE", level: "ERROR", code: "MODEL_OUTPUT_TRUNCATED", message: `模型输出达到 max_tokens 上限被截断（finish_reason=length，max_tokens=${input.params.max_tokens ?? "服务商默认"}）。可调大 max_tokens 后重跑。` }]
          : [];
      const diag = diagByPhase(pr);
      return finishRun({
        ...done,
        ...versionsOf(pr),
        status: pr.status,
        raw_response: result.raw,
        raw_response_hash: sha256(result.raw),
        parsed_json: pr.parse.value,
        parse_diagnostics: [...truncated, ...diag.parse_diagnostics],
        schema_diagnostics: diag.schema_diagnostics,
        view_model: pr.viewModel ? { ...pr.viewModel, diagnostics: [...truncated, ...pr.viewModel.diagnostics] } : null,
        token_usage: result.usage,
        finish_reason: finishReason,
        error: null,
      });
    } catch (e) {
      // 任何意外异常也要落到终态，不能永远停在 RUNNING
      return finishRun({
        ...common,
        ...noResult,
        ended_at: new Date().toISOString(),
        latency_ms: null,
        status: "MODEL_ERROR",
        raw_response: "",
        raw_response_hash: sha256(""),
        error: { code: "RUN_INTERNAL_ERROR", message: redactSecrets(e instanceof Error ? e.message : String(e)) },
      });
    }
  }
}

/**
 * 重新渲染历史 Run：读取不可变原文与当时快照，用当前 Adapter/Renderer 重跑解析与视图。
 * 结果另存为新的 REPLAY Run，标明版本变化；不覆盖历史 Run。
 */
export function rerender(runId: string): Run {
  const orig = getRun(runId);
  if (!orig) throw new RunServiceError("RUN_NOT_FOUND", "Run 不存在", 404);
  if (orig.status === "RUNNING") throw new RunServiceError("RUN_NOT_FINISHED", "Run 仍在运行中，结束后才能重渲染", 409);
  const snapshot = loadSnapshot(orig.input_snapshot_id);
  const newRunId = newId("run");
  const ctx = contextFromSnapshot(newRunId, orig.prompt_kind, snapshot);
  if (orig.mode === "MODEL_RUN" && snapshot) {
    const built = buildInput(orig.prompt_kind, snapshot);
    if (built.ok) ctx.request = built.request;
  }
  const pr = runPipeline({ raw: orig.raw_response, promptKind: orig.prompt_kind, context: ctx });
  const changes: string[] = [];
  if (orig.adapter_id !== (pr.adapterId ?? null) || orig.adapter_version !== (pr.adapterVersion ?? null))
    changes.push(`Adapter ${orig.adapter_id ?? "无"}@${orig.adapter_version ?? "-"} → ${pr.adapterId ?? "无"}@${pr.adapterVersion ?? "-"}`);
  if (orig.renderer_config_version !== (pr.rendererConfigVersion ?? null)) changes.push(`RendererConfig ${orig.renderer_config_version ?? "-"} → ${pr.rendererConfigVersion ?? "-"}`);
  if (orig.schema_id !== (pr.validation.schemaId ?? null)) changes.push(`Schema ${orig.schema_id ?? "-"} → ${pr.validation.schemaId ?? "-"}`);
  const run: Run & { label?: string } = {
    ...orig,
    run_id: newRunId,
    mode: "REPLAY",
    replay_of_run_id: orig.run_id,
    rerender_note: changes.length ? `仅重新渲染（版本变化：${changes.join("；")}）` : "仅重新渲染（Adapter/Renderer 版本未变化）",
    ...versionsOf(pr),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    status: orig.status === "MODEL_ERROR" ? "MODEL_ERROR" : pr.status,
    parsed_json: pr.parse.value,
    ...diagByPhase(pr),
    view_model: orig.status === "MODEL_ERROR" ? null : pr.viewModel ?? null,
    label: `重渲染 · ${(orig as Run & { label?: string }).label ?? orig.run_id}`,
  };
  return saveRun(run);
}

export function rendererFor(run: Run) {
  return run.view_model ? findRendererConfig(run.view_model.rendererId) : undefined;
}

export { findAdapterById };
