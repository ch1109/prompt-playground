import { rejectForeignOrigin } from "@/lib/api/origin";
import { fail, handle, ok } from "@/lib/api/respond";
import { resetModelListCache } from "@/lib/models/catalog";
import { clearModelConfig, effectiveModelConfig, readModelConfig, writeModelConfig } from "@/lib/models/config-store";
import { explainModelError } from "@/lib/models/error-hints";
import { OpenAICompatibleProvider, redactSecrets } from "@/lib/models/openai-compatible";

// 网页「模型设置」。密钥只进不出：任何响应都不含完整密钥，也不写日志。

type Input = { baseUrl: string; model: string; apiKey: string | undefined };

/** 校验请求体：服务地址必须是 http(s) 地址（去掉末尾 /），模型名不能空；密钥为空表示沿用已保存的 */
async function parseInput(req: Request): Promise<Input | Response> {
  let b: { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  try {
    b = await req.json();
  } catch {
    return fail("BAD_JSON_BODY", "请求体不是合法 JSON");
  }
  const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : "";
  const model = typeof b.model === "string" ? b.model.trim() : "";
  let valid = false;
  try {
    valid = /^https?:$/.test(new URL(baseUrl).protocol);
  } catch {}
  if (!valid) return fail("BAD_BASE_URL", "服务地址要以 http:// 或 https:// 开头，并且是完整的网址");
  if (!model) return fail("BAD_MODEL", "请填写模型名称");
  const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;
  return { baseUrl, model, apiKey };
}

/** 本次要用的密钥：填了用填的；没填时只在服务地址没变的情况下沿用已保存的（换了地址必须重填，避免把旧密钥发给别的地址；也不用环境变量里的） */
function resolveKey(i: Input): string | null {
  if (i.apiKey) return i.apiKey;
  const saved = readModelConfig();
  return saved && saved.baseUrl === i.baseUrl ? saved.apiKey : null;
}

/** 用这组信息临时建一个 provider 读模型列表；失败给中文原因（经脱敏，不含密钥） */
async function testConnection(i: Input, apiKey: string): Promise<{ ok: true; modelFound: boolean; modelCount: number } | { ok: false; message: string }> {
  try {
    const models = await new OpenAICompatibleProvider({ baseUrl: i.baseUrl, model: i.model, apiKey, timeoutMs: 15000 }).listModels();
    return { ok: true, modelFound: models.includes(i.model), modelCount: models.length };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    const status = /HTTP (\d{3})/.exec(text)?.[1];
    const code = status ? `MODEL_HTTP_${status}` : e instanceof Error && e.name === "TimeoutError" ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR";
    const hint = explainModelError(code);
    // 超时的建议是调环境变量，这里只给原因；网络错误附上去掉密钥的底层原因
    const extra = code === "MODEL_NETWORK_ERROR" ? `（${redactSecrets(text, [apiKey])}）` : "";
    return { ok: false, message: redactSecrets(code === "MODEL_TIMEOUT" ? `${hint.title}，请检查服务地址是否可以访问` : `${hint.title}。${hint.advice}${extra}`, [apiKey]) };
  }
}

function info() {
  const c = effectiveModelConfig();
  const k = c.apiKey ?? "";
  return { source: c.source, baseUrl: c.baseUrl ?? "", model: c.model ?? "", hasKey: k.length > 0, keyTail: k.length >= 8 ? k.slice(-4) : null };
}

export const GET = () => handle(() => ok(info()));

export const POST = (req: Request) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true);
    if (denied) return denied;
    const input = await parseInput(req);
    if (input instanceof Response) return input;
    const key = resolveKey(input);
    if (!key) return fail("NO_API_KEY", "请填写密钥（换了服务地址需要重新填写）");
    const r = await testConnection(input, key);
    return r.ok ? ok(r) : fail("CONNECT_FAILED", r.message);
  });

export const PUT = (req: Request) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true);
    if (denied) return denied;
    const input = await parseInput(req);
    if (input instanceof Response) return input;
    const key = resolveKey(input);
    if (!key) return fail("NO_API_KEY", "请填写密钥（换了服务地址需要重新填写）");
    const r = await testConnection(input, key);
    if (!r.ok) return fail("CONNECT_FAILED", r.message);
    writeModelConfig({ baseUrl: input.baseUrl, model: input.model, apiKey: key });
    resetModelListCache();
    return ok({ ...info(), modelFound: r.modelFound, modelCount: r.modelCount });
  });

export const DELETE = (req: Request) =>
  handle(() => {
    const denied = rejectForeignOrigin(req, false);
    if (denied) return denied;
    clearModelConfig();
    resetModelListCache();
    return ok(info());
  });
