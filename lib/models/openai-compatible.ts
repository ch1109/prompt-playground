import { sha256 } from "@/lib/hash";
import type { ModelRequest, ModelResult, ProviderAdapter, ProviderCapabilities, ProviderInfo } from "./provider-adapter";

// OpenAI 兼容 /chat/completions（DashScope、OpenAI、OpenRouter 等）。
// 只在服务端运行；API Key 只从环境变量读取，绝不返回给浏览器或写进 Run。

// 1.1.0：能力声明（capabilities）
// 1.2.0：返回实际请求的脱敏副本与完整响应元数据（usage、服务商回报的模型名、是否有思考内容）
// 1.3.0：返回思考内容全文（reasoning_content）
export const OPENAI_COMPATIBLE_VERSION = "1.3.0";

const flag = (v: string | undefined): boolean | null => (v === undefined || v === "" ? null : /^(1|true|yes)$/i.test(v));

/** 从环境变量读能力声明：MODEL_SUPPORTS_IMAGES / MODEL_SUPPORTS_JSON_MODE / MODEL_SUPPORTS_THINKING / MODEL_MAX_OUTPUT_TOKENS；未填即「未声明」 */
export function capabilitiesFromEnv(env: Record<string, string | undefined> = process.env): ProviderCapabilities {
  const max = Number(env.MODEL_MAX_OUTPUT_TOKENS);
  return {
    images: flag(env.MODEL_SUPPORTS_IMAGES),
    nativePdf: false,
    jsonMode: flag(env.MODEL_SUPPORTS_JSON_MODE),
    thinking: flag(env.MODEL_SUPPORTS_THINKING),
    streaming: false,
    maxOutputTokens: Number.isFinite(max) && max > 0 ? max : null,
  };
}

const UNDECLARED_CAPABILITIES: ProviderCapabilities = { images: null, nativePdf: false, jsonMode: null, thinking: null, streaming: false, maxOutputTokens: null };

export function redactSecrets(text: string, extraSecrets: (string | undefined)[] = []): string {
  let out = text;
  for (const key of [process.env.MODEL_API_KEY, process.env.JIULI_API_TOKEN, ...extraSecrets]) {
    if (key && key.length > 4) out = out.split(key).join("***");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1***").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  constructor(
    private env: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number; capabilities?: ProviderCapabilities } = {
      baseUrl: process.env.MODEL_BASE_URL,
      model: process.env.MODEL_NAME,
      apiKey: process.env.MODEL_API_KEY,
      // 视觉模型附带多页图片时常超过 2 分钟
      timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 300000),
    },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** 同一服务商、同一密钥，换一个模型名；能力声明只属于 .env.local 里的默认模型，换模型后一律「未声明」 */
  withModel(model: string): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({ ...this.env, model, capabilities: UNDECLARED_CAPABILITIES }, this.fetchImpl);
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
    };
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const started = Date.now();
    if (!this.info().configured) {
      return { ok: false, code: "MODEL_NOT_CONFIGURED", message: "未配置 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY（.env.local）", latencyMs: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.env.timeoutMs ?? 300000);
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
      stream: false,
    };
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
          stream: false,
        }),
        signal: controller.signal,
      });
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
        message: aborted ? `超过 ${this.env.timeoutMs}ms 未返回` : this.redact(e instanceof Error ? e.message : String(e)),
        latencyMs: Date.now() - started,
        request,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

let provider: ProviderAdapter | undefined;
/** 不传模型或与默认模型相同 → 默认模型（.env.local 的 MODEL_NAME）；否则同一服务商换成该模型 */
export function getProvider(model?: string | null): ProviderAdapter {
  provider ??= new OpenAICompatibleProvider();
  return model && model !== provider.info().model && provider instanceof OpenAICompatibleProvider ? provider.withModel(model) : provider;
}
/** 测试注入 */
export function setProviderForTests(p: ProviderAdapter | undefined) {
  provider = p;
}
