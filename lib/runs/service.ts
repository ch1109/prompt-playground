import { findAdapterById } from "@/lib/adapters/registry";
import type { AdapterContext, MaterialAccess } from "@/lib/adapters/types";
import type { ModelParams, PipelineResult, PromptKind, Run, RunMode } from "@/lib/contracts/run";
import type { Diagnostic } from "@/lib/contracts/view-model";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { newId, sha256, stableStringify } from "@/lib/hash";
import { buildInput, INPUT_BUILDER_VERSION, renderUserTemplate, unresolvedVariables, type BuildResult } from "@/lib/input-builders";
import { getProvider, redactSecrets } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { findRendererConfig } from "@/lib/renderer-config/registry";
import { contentHash, getPrompt, getVersion } from "@/lib/repositories/prompts";
import { finishRun, getRun, saveRun, startRun } from "@/lib/repositories/runs";
import { getEgressConsent } from "@/lib/repositories/egress";
import { getSnapshot, snapshotDeletedAt } from "@/lib/repositories/snapshots";
import { materialInfo } from "@/lib/materials/store";
import type { ProviderCapabilities } from "@/lib/models/provider-adapter";
import { buildInputManifest } from "./input-manifest";
import { buildPageImages, planPageImages, referencedFileIds, type PageImageCoverage } from "./page-images";

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
    adapter_diagnostics: result.diagnostics.filter((d) => d.phase === "ADAPTER" || d.phase === "RENDER"),
  };
}

/** P3/P4 的上游说明：输入来自快照（九立只读或录制请求），不是本系统某次 P1/P2 Run 的输出 */
function upstreamOf(kind: PromptKind) {
  return kind === "JIULI_P3" || kind === "JIULI_P4" ? { upstream_run_ids: [] as string[], upstream_note: "输入来自快照，不是本系统上游 Run 的输出，无法关联上游 Run" } : {};
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

/**
 * 是否附带原件图片：调用方明确传了就照办；没传时，模型声明支持看图且输入引用了 PDF / 图片就自动附带。
 */
export function effectiveAttachImages(explicit: boolean | undefined, caps: ProviderCapabilities, request: Record<string, unknown>, snapshot: InputSnapshot): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (caps.images !== true) return false;
  const media = new Map(snapshot.materials.map((m) => [m.file_id, m.media_type ?? ""]));
  return referencedFileIds(request).some((id) => media.get(id) === "application/pdf" || !!media.get(id)?.startsWith("image/"));
}

const PARAM_KEYS = new Set(["temperature", "max_tokens", "top_p"]);

/** 运行前就能确定的阻断原因（R-03 / R-04）：悬空变量、参数不合法、模型能力不满足 */
export function runBlockers(input: { system: string; userTemplate: string; params: ModelParams; attachImages?: boolean }, caps: ProviderCapabilities): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const vars = unresolvedVariables(input.system, input.userTemplate);
  if (vars.length) out.push({ code: "UNRESOLVED_TEMPLATE_VARIABLE", message: `提示词中有未登记的变量 ${vars.join("、")}，展开后会原样发给模型。只支持 {{input_json}}，请删除或改正后再运行。` });
  const p = input.params ?? {};
  for (const k of Object.keys(p)) if (!PARAM_KEYS.has(k)) out.push({ code: "MODEL_PARAM_UNSUPPORTED", message: `参数 ${k} 不在本适配器支持的范围（temperature / max_tokens / top_p），不会被当作生效` });
  if (p.temperature !== undefined && !(typeof p.temperature === "number" && p.temperature >= 0 && p.temperature <= 2)) out.push({ code: "MODEL_PARAM_INVALID", message: `temperature=${String(p.temperature)} 不合法（应为 0~2）` });
  if (p.top_p !== undefined && !(typeof p.top_p === "number" && p.top_p > 0 && p.top_p <= 1)) out.push({ code: "MODEL_PARAM_INVALID", message: `top_p=${String(p.top_p)} 不合法（应为 0~1）` });
  if (p.max_tokens !== undefined && !(Number.isInteger(p.max_tokens) && (p.max_tokens as number) > 0)) out.push({ code: "MODEL_PARAM_INVALID", message: `max_tokens=${String(p.max_tokens)} 不合法（应为正整数）` });
  else if (p.max_tokens !== undefined && caps.maxOutputTokens !== null && (p.max_tokens as number) > caps.maxOutputTokens)
    out.push({ code: "MODEL_PARAM_INVALID", message: `max_tokens=${p.max_tokens} 超过模型声明的上限 ${caps.maxOutputTokens}（MODEL_MAX_OUTPUT_TOKENS）` });
  if (input.attachImages && caps.images === false) out.push({ code: "CAPABILITY_UNSUPPORTED", message: "已勾选「附带原件图片」，但当前模型声明不支持图片输入（MODEL_SUPPORTS_IMAGES=false）。请取消勾选，或换用视觉模型。" });
  return out;
}

/** token 粗估：中日韩等非 ASCII 字符约 1 字 1 token，ASCII 约 4 字符 1 token；不含图片，只作量级参考 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) ch.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4 + other);
}

async function manifestFor(request: Record<string, unknown>, snapshot: InputSnapshot, built: Extract<BuildResult, { ok: true }>, attachImages: boolean, coverage: PageImageCoverage[] | null, system: string, user: string, caps: ProviderCapabilities) {
  const ids = [...new Set([...referencedFileIds(request), ...(coverage ?? []).map((c) => c.file_id)])];
  const fileMeta = ids.length ? await materialInfo(ids).catch(() => []) : [];
  return buildInputManifest({
    request,
    snapshot,
    builderId: built.builderId,
    builderVersion: INPUT_BUILDER_VERSION,
    blockedFiles: blockedFiles(built.requiresFiles, snapshot, attachImages),
    attachImages,
    imageCoverage: coverage,
    fileMeta,
    systemChars: system.length,
    userChars: user.length,
    visionSupported: caps.images,
  });
}

/** 运行前预览：实际发送的系统提示词、用户消息、参数、输入覆盖与阻断原因 */
export async function previewModelRun(input: { promptId: string; snapshotId: string; system: string; userTemplate: string; attachImages?: boolean; params?: ModelParams; model?: string | null }) {
  const prompt = loadPrompt(input.promptId);
  const snapshot = loadSnapshot(input.snapshotId)!;
  const built = buildInput(prompt.prompt_kind, snapshot);
  const info = getProvider(input.model).info();
  if (!built.ok) return { ok: false as const, code: built.code, message: built.message, provider: info };
  const user = renderUserTemplate(input.userTemplate, built.request);
  const attach = effectiveAttachImages(input.attachImages, info.capabilities, built.request, snapshot);
  // 只列出将附带的原件并按页数上限规划，不在预览时转换 PDF
  const ids = attach ? referencedFileIds(built.request) : [];
  const attachFiles = ids.length ? await materialInfo(ids) : [];
  const coverage = attach ? await planPageImages(ids) : null;
  const params = input.params ?? {};
  return {
    ok: true as const,
    attachImages: attach,
    attachFiles: attach ? attachFiles : null,
    provider: info,
    builderId: built.builderId,
    warnings: built.warnings,
    requiresFiles: blockedFiles(built.requiresFiles, snapshot, attach),
    request: built.request,
    system: redactSecrets(input.system),
    user: redactSecrets(user),
    params,
    tokenEstimate: estimateTokens(input.system) + estimateTokens(user),
    blockers: runBlockers({ ...input, params }, info.capabilities),
    manifest: await manifestFor(built.request, snapshot, built, attach, coverage, input.system, user, info.capabilities),
    actualPromptHash: contentHash(input.system, user),
    builtInputHash: sha256(stableStringify(built.request)),
  };
}

/** 运行中调用的中止开关（按 runId）；放在 globalThis，开发模式热更新后仍是同一份 */
const running = ((globalThis as unknown as { __studioRunAborts?: Map<string, AbortController> }).__studioRunAborts ??= new Map());

/** 取消运行中的调用：停止等待模型，Run 记为 CANCELLED。服务商可能已开始处理并计费。 */
export function cancelRun(runId: string) {
  const ac = running.get(runId);
  if (!ac) throw new RunServiceError("RUN_NOT_RUNNING", "这次运行已结束或不在本服务进程中，无法取消", 409);
  ac.abort();
}

type ModelRunInput = Base & { snapshotId: string; system: string; userTemplate: string; promptVersionId?: string | null; params: ModelParams; /** 不填 = 默认模型；调用方须先确认它在可用列表里 */ model?: string | null; attachImages?: boolean; retryOfRunId?: string | null; /** 谁授权外发：web:<用户> / agent:<principal>；不传记为 unknown */ authorizedBy?: string; experimentRef?: Run["experiment_ref"] };

/** 外发了哪几类材料：文字一定有；附带了页面图片再加图片 */
export function egressKinds(imageCount: number): ("text" | "image")[] {
  return imageCount > 0 ? ["text", "image"] : ["text"];
}

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
  const provider = getProvider(input.model);
  const info = provider.info();
  if (!info.configured) throw new RunServiceError("MODEL_NOT_CONFIGURED", "未配置模型（.env.local 中的 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY）", 400);

  const blockers = runBlockers(input, info.capabilities);
  if (blockers.length) throw new RunServiceError(blockers[0].code, blockers.map((b) => b.message).join("；"), 400);
  const built = buildInput(prompt.prompt_kind, snapshot);
  if (!built.ok) throw new RunServiceError(built.code, built.message, 400);
  const attach = effectiveAttachImages(input.attachImages, info.capabilities, built.request, snapshot);
  // AT27：模型不支持文件且材料没有预处理文本 → 明确阻断，不会只发文件名
  const blocked = blockedFiles(built.requiresFiles, snapshot, attach);
  if (blocked.length && !info.supportsFileInput) {
    throw new RunServiceError(
      "FILE_INPUT_UNSUPPORTED",
      `当前模型（${info.provider}）只接收文本，材料 ${blocked.join(", ")} 没有预处理文本。PDF / 图片可在「提示词」页「运行参数」里勾选「附带原件图片」后用视觉模型运行；其他格式请先生成预处理文本，或配置支持文件输入的模型。`,
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
    prompt_source: { system: input.system, user_template: input.userTemplate },
    built_input: built.request,
    ...upstreamOf(prompt.prompt_kind),
    retry_of_run_id: input.retryOfRunId ?? null,
    ...(input.experimentRef ? { experiment_ref: input.experimentRef } : {}),
    input_manifest: null as Run["input_manifest"],
    timing: null as Run["timing"],
  };
  const noResult = { schema_id: null, schema_version: null, adapter_id: null, adapter_version: null, renderer_config_version: null, parse_diagnostics: [], schema_diagnostics: [], view_model: null, token_usage: null };

  // 先登记 RUNNING：调用期间历史中可见；进程中断时启动会标为 INTERRUPTED
  startRun({ ...common, ...noResult, status: "RUNNING", ended_at: null, latency_ms: null, raw_response: "", raw_response_hash: "", error: null });

  const request = built.request;
  const builtOk = built;
  const builderWarnings = built.warnings;
  const abort = new AbortController();
  running.set(runId, abort);
  // 外发记录：材料真正交给服务商前才写入，没发出请求的 Run 没有这一项
  const authorizedBy = input.authorizedBy ?? "unknown";
  const providerHost = info.baseUrlHost ?? info.provider;
  let egress: Run["egress"];
  const egressField = () => (egress ? { egress } : {});
  const cancelled = () =>
    finishRun({
      ...common,
      ...noResult,
      ended_at: new Date().toISOString(),
      latency_ms: Date.now() - Date.parse(started),
      status: "CANCELLED",
      raw_response: "",
      raw_response_hash: sha256(""),
      ...egressField(),
      error: { code: "CANCELLED", message: "用户取消了这次运行（服务商可能已开始处理并计费）" },
    });
  return { runId, done: finishModelRun().finally(() => running.delete(runId)) };

  async function finishModelRun(): Promise<Run> {
    try {
      const t0 = Date.now();
      const pages = attach ? await buildPageImages(referencedFileIds(request)) : null;
      const manifest = await manifestFor(request, snapshot, builtOk, attach, pages?.coverage ?? null, input.system, user, info.capabilities);
      const preprocessMs = pages ? Date.now() - t0 : null;
      if (abort.signal.aborted) return cancelled();
      const images = pages?.images.map((i) => ({ mediaType: i.media_type, base64: i.base64, ref: { file_id: i.file_id, page: i.page, sha256: i.sha256 } }));
      egress = { provider_host: providerHost, kinds: egressKinds(images?.length ?? 0), authorized_by: authorizedBy, consent_at: authorizedBy.startsWith("agent:") ? null : (getEgressConsent(input.projectId, providerHost)?.confirmed_at ?? null) };
      const result = await provider.complete({ system: input.system, user, params: input.params, images, signal: abort.signal });
      if (abort.signal.aborted) return cancelled();
      const done = {
        ...common,
        input_manifest: manifest,
        timing: { preprocess_ms: preprocessMs, inference_ms: result.latencyMs, parse_ms: null as number | null },
        // 附带图片时，图片 hash 也计入实际提示词 hash
        actual_prompt_hash: pages?.images.length ? contentHash(input.system, `${user}\n${pages.images.map((i) => i.sha256).join(",")}`) : common.actual_prompt_hash,
        attached_images: pages ? pages.images.map(({ base64: _b, ...m }) => m) : null,
        input_builder_warnings: [...builderWarnings, ...(pages?.warnings ?? [])],
        egress,
        request_actual: result.request ?? null,
        ended_at: new Date().toISOString(),
        latency_ms: result.latencyMs,
      };

      if (!result.ok) {
        const raw = result.partialRaw ?? "";
        return finishRun({ ...done, ...noResult, status: "MODEL_ERROR", raw_response: raw, raw_response_hash: sha256(raw), error: { code: result.code, message: result.message } });
      }

      const finishReason = typeof result.responseMeta.finish_reason === "string" ? result.responseMeta.finish_reason : null;
      const t1 = Date.now();
      const pr = runPipeline({ raw: result.raw, promptKind: prompt.prompt_kind, context: { ...contextFromSnapshot(runId, prompt.prompt_kind, snapshot), request: request } });
      // 达到 max_tokens 被截断：单独说明原因，避免只看到"JSON 解析失败"
      const truncated: Diagnostic[] =
        finishReason === "length"
          ? [{ phase: "PARSE", level: "ERROR", code: "MODEL_OUTPUT_TRUNCATED", message: `模型输出达到 max_tokens 上限被截断（finish_reason=length，max_tokens=${input.params.max_tokens ?? "服务商默认"}）。可调大 max_tokens 后重跑。` }]
          : [];
      const diag = diagByPhase(pr);
      return finishRun({
        ...done,
        timing: { ...done.timing, parse_ms: Date.now() - t1 },
        provider_request_id: typeof result.responseMeta.id === "string" ? result.responseMeta.id : null,
        ...versionsOf(pr),
        status: pr.status,
        raw_response: result.raw,
        raw_response_hash: sha256(result.raw),
        parsed_json: pr.parse.value,
        parse_diagnostics: [...truncated, ...diag.parse_diagnostics],
        schema_diagnostics: diag.schema_diagnostics,
        adapter_diagnostics: diag.adapter_diagnostics,
        response_meta: result.responseMeta,
        reasoning_content: result.reasoning ?? null,
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
        ...egressField(),
        error: { code: "RUN_INTERNAL_ERROR", message: redactSecrets(e instanceof Error ? e.message : String(e)) },
      });
    }
  }
}

/**
 * 原样重试：用原 Run 的同一快照、同一提示词原文、同一参数和图片开关新建 Run；原 Run 不变。
 * v1.1 之前的 Run 没有保存提示词原文，不能重试（不拿当前编辑内容冒充）。
 */
export function retryRun(runId: string, authorizedBy?: string): { runId: string; done: Promise<Run> } {
  const orig = getRun(runId) as (Run & { label?: string }) | undefined;
  if (!orig) throw new RunServiceError("RUN_NOT_FOUND", "Run 不存在", 404);
  if (orig.mode !== "MODEL_RUN") throw new RunServiceError("RETRY_NOT_APPLICABLE", "只有真实模型运行可以重试；仅渲染请直接重新渲染", 400);
  if (orig.status === "RUNNING") throw new RunServiceError("RUN_NOT_FINISHED", "Run 仍在运行中", 409);
  if (!orig.prompt_source || !orig.input_snapshot_id) throw new RunServiceError("RETRY_SOURCE_MISSING", "这条 Run 没有保存运行时的提示词原文（v1.1 之前的记录），无法原样重试", 400);
  return startModelRun({
    projectId: orig.project_id,
    promptId: orig.prompt_id,
    snapshotId: orig.input_snapshot_id,
    system: orig.prompt_source.system,
    userTemplate: orig.prompt_source.user_template,
    promptVersionId: orig.prompt_version_id,
    params: orig.model_params ?? {},
    attachImages: !!orig.attached_images,
    label: `重试 · ${orig.label ?? orig.run_id}`,
    retryOfRunId: orig.run_id,
    authorizedBy,
  });
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
    label: `重新整理 · ${((orig as Run & { label?: string }).label ?? orig.run_id).replace(/^(重新整理|重渲染) · /, "")}`,
  };
  return saveRun(run);
}

export function rendererFor(run: Run) {
  return run.view_model ? findRendererConfig(run.view_model.rendererId) : undefined;
}

export { findAdapterById };
