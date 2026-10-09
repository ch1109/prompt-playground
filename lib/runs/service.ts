import { findAdapterById } from "@/lib/adapters/registry";
import type { AdapterContext, MaterialAccess } from "@/lib/adapters/types";
import type { ModelParams, PipelineResult, PromptKind, Run, RunMode } from "@/lib/contracts/run";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { newId, sha256, stableStringify } from "@/lib/hash";
import { buildInput, renderUserTemplate } from "@/lib/input-builders";
import { getProvider, redactSecrets } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { findRendererConfig } from "@/lib/renderer-config/registry";
import { contentHash, getPrompt, getVersion } from "@/lib/repositories/prompts";
import { getRun, saveRun } from "@/lib/repositories/runs";
import { getSnapshot } from "@/lib/repositories/snapshots";

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
  if (!s) throw new RunServiceError("SNAPSHOT_NOT_FOUND", "快照不存在", 404);
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

/** 运行前预览：实际发送的系统提示词、用户消息与构造输入 */
export function previewModelRun(input: { promptId: string; snapshotId: string; system: string; userTemplate: string }) {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId)!;
  const built = buildInput(prompt.prompt_kind, snapshot);
  const info = getProvider().info();
  if (!built.ok) return { ok: false as const, code: built.code, message: built.message, provider: info };
  const user = renderUserTemplate(input.userTemplate, built.request);
  return {
    ok: true as const,
    provider: info,
    builderId: built.builderId,
    warnings: built.warnings,
    requiresFiles: built.requiresFiles,
    request: built.request,
    system: input.system,
    user,
    actualPromptHash: contentHash(input.system, user),
    builtInputHash: sha256(stableStringify(built.request)),
  };
}

/** MODEL_RUN：服务端代理真实模型调用；失败保存失败 Run，绝不回退为 Mock */
export async function modelRun(
  input: Base & { snapshotId: string; system: string; userTemplate: string; promptVersionId?: string | null; params: ModelParams },
): Promise<Run> {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId)!;
  const provider = getProvider();
  const info = provider.info();
  if (!info.configured) throw new RunServiceError("MODEL_NOT_CONFIGURED", "未配置模型（.env.local 中的 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY）", 400);

  const built = buildInput(prompt.prompt_kind, snapshot);
  if (!built.ok) throw new RunServiceError(built.code, built.message, 400);
  // AT27：模型不支持文件且材料没有预处理文本 → 明确阻断，不会只发文件名
  if (built.requiresFiles.length && !info.supportsFileInput) {
    throw new RunServiceError(
      "FILE_INPUT_UNSUPPORTED",
      `当前模型（${info.provider}）只接收文本，材料 ${built.requiresFiles.join(", ")} 没有预处理文本。请先生成预处理文本（例如九立 Demo extracted），或配置支持文件输入的模型。`,
      400,
    );
  }

  const version = input.promptVersionId ? getVersion(input.promptVersionId) : undefined;
  const isDraft = !version || version.content_hash !== contentHash(input.system, input.userTemplate);
  const user = renderUserTemplate(input.userTemplate, built.request);
  const runId = newId("run");
  const started = new Date().toISOString();
  const result = await provider.complete({ system: input.system, user, params: input.params });

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
    actual_prompt: { system: redactSecrets(input.system), user: redactSecrets(user) },
    started_at: started,
    ended_at: new Date().toISOString(),
    latency_ms: result.latencyMs,
    estimated_cost: null,
    label: input.label ?? `${info.model} 运行`,
    input_builder_id: built.builderId,
    input_builder_warnings: built.warnings,
  };

  if (!result.ok) {
    const raw = result.partialRaw ?? "";
    const run: Run = {
      ...common,
      schema_id: null,
      schema_version: null,
      adapter_id: null,
      adapter_version: null,
      renderer_config_version: null,
      status: "MODEL_ERROR",
      raw_response: raw,
      raw_response_hash: sha256(raw),
      parse_diagnostics: [],
      schema_diagnostics: [],
      view_model: null,
      token_usage: null,
      error: { code: result.code, message: result.message },
    };
    return saveRun(run);
  }

  const pr = runPipeline({ raw: result.raw, promptKind: prompt.prompt_kind, context: { ...contextFromSnapshot(runId, prompt.prompt_kind, snapshot), request: built.request } });
  const run: Run = {
    ...common,
    ...versionsOf(pr),
    status: pr.status,
    raw_response: result.raw,
    raw_response_hash: sha256(result.raw),
    parsed_json: pr.parse.value,
    ...diagByPhase(pr),
    view_model: pr.viewModel ?? null,
    token_usage: result.usage,
    error: null,
  };
  return saveRun(run);
}

/**
 * 重新渲染历史 Run：读取不可变原文与当时快照，用当前 Adapter/Renderer 重跑解析与视图。
 * 结果另存为新的 REPLAY Run，标明版本变化；不覆盖历史 Run。
 */
export function rerender(runId: string): Run {
  const orig = getRun(runId);
  if (!orig) throw new RunServiceError("RUN_NOT_FOUND", "Run 不存在", 404);
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
