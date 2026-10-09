import type { ModelRequest, ModelResult, ProviderAdapter, ProviderInfo } from "./provider-adapter";

// OpenAI 兼容 /chat/completions（DashScope、OpenAI、OpenRouter 等）。
// 只在服务端运行；API Key 只从环境变量读取，绝不返回给浏览器或写进 Run。

export const OPENAI_COMPATIBLE_VERSION = "1.0.0";

export function redactSecrets(text: string, extraSecrets: (string | undefined)[] = []): string {
  let out = text;
  for (const key of [process.env.MODEL_API_KEY, process.env.JIULI_API_TOKEN, ...extraSecrets]) {
    if (key && key.length > 4) out = out.split(key).join("***");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1***").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  constructor(
    private env: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number } = {
      baseUrl: process.env.MODEL_BASE_URL,
      model: process.env.MODEL_NAME,
      apiKey: process.env.MODEL_API_KEY,
      // 视觉模型附带多页图片时常超过 2 分钟
      timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 300000),
    },
    private fetchImpl: typeof fetch = fetch,
  ) {}

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
        return { ok: false, code: "MODEL_STREAM_BROKEN", message: `读取响应失败（可能断流）：${this.redact(String(e))}`, latencyMs: Date.now() - started };
      }
      if (!res.ok) {
        return { ok: false, code: `MODEL_HTTP_${res.status}`, message: this.redact(text.slice(0, 2000)), latencyMs: Date.now() - started, partialRaw: this.redact(text) };
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, code: "MODEL_BAD_ENVELOPE", message: "服务商返回的不是 JSON 包装（可能被截断）", latencyMs: Date.now() - started, partialRaw: this.redact(text) };
      }
      const choice = (body.choices as { message?: { content?: unknown }; finish_reason?: string }[] | undefined)?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") {
        return { ok: false, code: "MODEL_EMPTY_CONTENT", message: "响应中没有 choices[0].message.content", latencyMs: Date.now() - started, partialRaw: this.redact(text) };
      }
      const u = body.usage as Record<string, number> | undefined;
      return {
        ok: true,
        raw: content,
        usage: u ? { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null } : null,
        latencyMs: Date.now() - started,
        responseMeta: { id: body.id, model: body.model, finish_reason: choice?.finish_reason },
      };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR",
        message: aborted ? `超过 ${this.env.timeoutMs}ms 未返回` : this.redact(e instanceof Error ? e.message : String(e)),
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

let provider: ProviderAdapter | undefined;
export function getProvider(): ProviderAdapter {
  provider ??= new OpenAICompatibleProvider();
  return provider;
}
/** 测试注入 */
export function setProviderForTests(p: ProviderAdapter | undefined) {
  provider = p;
}
