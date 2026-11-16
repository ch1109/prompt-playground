import { sha256 } from "@/lib/hash";
import { effectiveModelConfig, readModelConfig } from "./config-store";
import type { ModelRequest, ModelResult, ProviderAdapter, ProviderCapabilities, ProviderInfo } from "./provider-adapter";

// OpenAI 兼容 /chat/completions（DashScope、OpenAI、OpenRouter 等）。
// 只在服务端运行；API Key 来自网页「模型设置」保存的文件或环境变量，绝不返回给浏览器或写进 Run。

// 1.1.0：能力声明（capabilities）
// 1.2.0：返回实际请求的脱敏副本与完整响应元数据（usage、服务商回报的模型名、是否有思考内容）
// 1.3.0：返回思考内容全文（reasoning_content）
// 1.4.0：传 onProgress 时流式接收，超时改为「多久没有新内容」
export const OPENAI_COMPATIBLE_VERSION = "1.4.0";

const flag = (v: string | undefined): boolean | null => (v === undefined || v === "" ? null : /^(1|true|yes)$/i.test(v));

/** 从环境变量读能力声明：MODEL_SUPPORTS_IMAGES / MODEL_SUPPORTS_JSON_MODE / MODEL_SUPPORTS_THINKING / MODEL_MAX_OUTPUT_TOKENS；未填即「未声明」 */
export function capabilitiesFromEnv(env: Record<string, string | undefined> = process.env): ProviderCapabilities {
  const max = Number(env.MODEL_MAX_OUTPUT_TOKENS);
  return {
    images: flag(env.MODEL_SUPPORTS_IMAGES),
    nativePdf: false,
    jsonMode: flag(env.MODEL_SUPPORTS_JSON_MODE),
    thinking: flag(env.MODEL_SUPPORTS_THINKING),
    streaming: true,
    maxOutputTokens: Number.isFinite(max) && max > 0 ? max : null,
  };
}

const UNDECLARED_CAPABILITIES: ProviderCapabilities = { images: null, nativePdf: false, jsonMode: null, thinking: null, streaming: true, maxOutputTokens: null };

export function redactSecrets(text: string, extraSecrets: (string | undefined)[] = []): string {
  let out = text;
  for (const key of [process.env.MODEL_API_KEY, readModelConfig()?.apiKey, process.env.JIULI_API_TOKEN, ...extraSecrets]) {
    if (key && key.length > 4) out = out.split(key).join("***");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1***").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

/** 服务地址 / 模型 / 密钥取生效配置（网页设置优先，其次环境变量）；超时只来自环境变量 */
function defaultEnv() {
  const { baseUrl, model, apiKey } = effectiveModelConfig();
  // 视觉模型附带多页图片时常超过 2 分钟
  return { baseUrl, model, apiKey, timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 300000) };
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  constructor(
    private env: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number; capabilities?: ProviderCapabilities } = defaultEnv(),
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** 同一服务商、同一密钥，换一个模型名；能力声明只属于 .env.local 里的默认模型，换模型后一律「未声明」 */
  withModel(model: string): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({ ...this.env, model, capabilities: UNDECLARED_CAPABILITIES }, this.fetchImpl);
  }

  /** 服务地址 + 密钥的标识，换了就要丢掉旧的模型列表缓存；只在内存里比较，不输出 */
  endpointKey(): string {
    return `${this.env.baseUrl}\n${this.env.apiKey}`;
  }

  /** 服务商的 GET /models 模型列表（OpenAI 兼容）；只返回模型名 */
  async listModels(): Promise<string[]> {
    if (!this.info().configured) return [];
    const res = await this.fetchImpl(this.env.baseUrl!.replace(/\/+$/, "") + "/models", { headers: { authorization: `Bearer ${this.env.apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`读取模型列表失败：HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  private redact(text: string) {
    return redactSecrets(text, [this.env.apiKey]);
  }

  info(): ProviderInfo {
    let host: string | undefined;
    try {
      host = this.env.baseUrl ? new URL(this.env.baseUrl).host : undefined;
    } catch {
      host = undefined;
    }
    return {
      provider: host ? `openai-compatible@${host}` : "openai-compatible",
      model: this.env.model ?? "",
      configured: !!(this.env.baseUrl && this.env.model && this.env.apiKey),
      supportsFileInput: false,
      adapterVersion: OPENAI_COMPATIBLE_VERSION,
      baseUrlHost: host,
      capabilities: this.env.capabilities ?? capabilitiesFromEnv(),
      timeoutMs: this.env.timeoutMs ?? 300000,
    };
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const started = Date.now();
    if (!this.info().configured) {
      return { ok: false, code: "MODEL_NOT_CONFIGURED", message: "还没设置模型（服务地址 / 模型名称 / 密钥）", latencyMs: 0 };
    }
    const stream = !!req.onProgress;
    const timeoutMs = this.env.timeoutMs ?? 300000;
    const controller = new AbortController();
    // 一次性返回：总时长超时；流式：每收到新内容重新计时，只有长时间没有新内容才算超时（模型还在思考或输出时不掐断）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    };
    arm();
    const timeoutMessage = stream ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有收到模型的新内容` : `超过 ${timeoutMs}ms 未返回`;
    const streamParams = stream ? { stream: true, stream_options: { include_usage: true } } : { stream: false };
    req.signal?.addEventListener("abort", () => controller.abort(req.signal?.reason));
    const url = this.env.baseUrl!.replace(/\/+$/, "") + "/chat/completions";
    const textRef = (t: string) => ({ text_chars: t.length, sha256: sha256(t) });
    // 实际请求的脱敏副本：结构与参数照实记录，正文只记长度与 hash（正文本身见 Run 的 actual_prompt），图片只记原件引用
    const request = {
      endpoint: "/chat/completions",
      model: this.env.model,
      messages: [
        { role: "system", content: textRef(req.system) },
        { role: "user", content: req.images?.length ? [{ type: "text", ...textRef(req.user) }, ...req.images.map((i) => ({ type: "image_url", media_type: i.mediaType, ...(i.ref ?? { sha256: sha256(i.base64) }) }))] : textRef(req.user) },
      ],
      ...req.params,
      ...streamParams,
    };
    const failed = (code: string, message: string, partialRaw?: string, partialReasoning?: string): ModelResult => ({
      ok: false,
      code,
      message,
      latencyMs: Date.now() - started,
      ...(partialRaw ? { partialRaw: this.redact(partialRaw) } : {}),
      ...(partialReasoning ? { partialReasoning: this.redact(partialReasoning) } : {}),
      request,
    });
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.apiKey}` },
        body: JSON.stringify({
          model: this.env.model,
          messages: [
            { role: "system", content: req.system },
            {
              role: "user",
              content: req.images?.length
                ? [{ type: "text", text: req.user }, ...req.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.base64}` } }))]
                : req.user,
            },
          ],
          ...req.params,
          ...streamParams,
        }),
        signal: controller.signal,
      });
      if (stream && res.ok && res.body && /event-stream/i.test(res.headers.get("content-type") ?? "")) return await this.readStream(res.body, { started, request, arm, onProgress: req.onProgress!, aborted: () => controller.signal.aborted, timeoutMessage, failed });
      // 服务商不支持流式、或返回的是错误：按一次性返回处理
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        return { ok: false, code: "MODEL_STREAM_BROKEN", message: `读取响应失败（可能断流）：${this.redact(String(e))}`, latencyMs: Date.now() - started, request };
      }
      if (!res.ok) {
        return { ok: false, code: `MODEL_HTTP_${res.status}`, message: this.redact(text.slice(0, 2000)), latencyMs: Date.now() - started, partialRaw: this.redact(text), request };
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, code: "MODEL_BAD_ENVELOPE", message: "服务商返回的不是 JSON 包装（可能被截断）", latencyMs: Date.now() - started, partialRaw: this.redact(text), request };
      }
      const choice = (body.choices as { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[] | undefined)?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") {
        return { ok: false, code: "MODEL_EMPTY_CONTENT", message: "响应中没有 choices[0].message.content", latencyMs: Date.now() - started, partialRaw: this.redact(text), request };
      }
      const u = body.usage as Record<string, number> | undefined;
      return {
        ok: true,
        raw: content,
        usage: u ? { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null } : null,
        latencyMs: Date.now() - started,
        // usage 原样保留（含服务商附加的明细，如思考 token）；思考内容全文单独返回，由 Run 保存
        responseMeta: {
          id: body.id,
          model: body.model,
          created: body.created,
          finish_reason: choice?.finish_reason,
          usage: body.usage ?? null,
          reasoning_content_chars: typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content.length : null,
        },
        request,
        reasoning: typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : null,
      };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR",
        message: aborted ? timeoutMessage : this.redact(e instanceof Error ? e.message : String(e)),
        latencyMs: Date.now() - started,
        request,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读 SSE 流（data: {...} 行，以 data: [DONE] 结束）：累计思考与回答，每段回调一次；中途失败时带上已收到的回答 */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    o: { started: number; request: Record<string, unknown>; arm: () => void; onProgress: NonNullable<ModelRequest["onProgress"]>; aborted: () => boolean; timeoutMessage: string; failed: (code: string, message: string, partialRaw?: string, partialReasoning?: string) => ModelResult },
  ): Promise<ModelResult> {
    type Chunk = { id?: unknown; model?: unknown; created?: unknown; error?: unknown; usage?: Record<string, number> | null; choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }[] };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    let finish: string | null = null;
    // 在 line() 里赋值；用对象属性存，避免类型收窄成 null
    const got: { usage: Record<string, number> | null } = { usage: null };
    let ended = false;
    let sawChoice = false;
    const meta: Record<string, unknown> = {};
    /** 处理一行；返回失败结果表示要中止 */
    const line = (l: string): ModelResult | undefined => {
      const data = l.startsWith("data:") ? l.slice(5).trim() : "";
      if (!data) return;
      if (data === "[DONE]") {
        ended = true;
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return o.failed("MODEL_BAD_ENVELOPE", "服务商返回的流式数据有一段不是 JSON（可能被截断）", content, reasoning);
      }
      if (chunk.error) return o.failed("MODEL_STREAM_BROKEN", `服务商在输出途中报错：${this.redact(JSON.stringify(chunk.error).slice(0, 2000))}`, content, reasoning);
      meta.id ??= chunk.id;
      meta.model ??= chunk.model;
      meta.created ??= chunk.created;
      if (chunk.usage) got.usage = chunk.usage;
      const c = chunk.choices?.[0];
      if (!c) return;
      sawChoice = true;
      if (typeof c.delta?.content === "string") content += c.delta.content;
      if (typeof c.delta?.reasoning_content === "string") reasoning += c.delta.reasoning_content;
      if (c.finish_reason) finish = c.finish_reason;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        o.arm();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const l of lines) {
          const bad = line(l);
          if (bad) {
            reader.cancel().catch(() => {});
            return bad;
          }
        }
        o.onProgress({ content, reasoning });
      }
      const bad = line(buf + decoder.decode());
      if (bad) return bad;
    } catch (e) {
      return o.aborted() ? o.failed("MODEL_TIMEOUT", o.timeoutMessage, content, reasoning) : o.failed("MODEL_STREAM_BROKEN", `读取响应失败（可能断流）：${this.redact(String(e))}`, content, reasoning);
    }
    if (!finish && !ended) return o.failed("MODEL_STREAM_BROKEN", "模型输出到一半连接断开，没有收到结束标记", content, reasoning);
    if (!sawChoice) return o.failed("MODEL_EMPTY_CONTENT", "流式响应中没有 choices 内容");
    const u = got.usage;
    return {
      ok: true,
      raw: content,
      usage: u ? { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null } : null,
      latencyMs: Date.now() - o.started,
      responseMeta: { ...meta, finish_reason: finish, usage: u, reasoning_content_chars: reasoning ? reasoning.length : null, streamed: true },
      request: o.request,
      reasoning: reasoning || null,
    };
  }
}

let injected: ProviderAdapter | undefined;
let cached: { key: string; p: OpenAICompatibleProvider } | undefined;
/** 每次按当前生效配置取 provider：配置（网页设置或环境变量）变了就重建，所以保存设置后立即生效，不用重启 */
function currentProvider(): ProviderAdapter {
  if (injected) return injected;
  const env = defaultEnv();
  const key = JSON.stringify(env);
  if (cached?.key !== key) cached = { key, p: new OpenAICompatibleProvider(env) };
  return cached.p;
}
/** 不传模型或与默认模型相同 → 默认模型（网页设置或 .env.local 的 MODEL_NAME）；否则同一服务商换成该模型 */
export function getProvider(model?: string | null): ProviderAdapter {
  const p = currentProvider();
  return model && model !== p.info().model && p instanceof OpenAICompatibleProvider ? p.withModel(model) : p;
}
/** 测试注入 */
export function setProviderForTests(p: ProviderAdapter | undefined) {
  injected = p;
}
