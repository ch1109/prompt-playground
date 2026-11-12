import { getProvider, OpenAICompatibleProvider, redactSecrets } from "./openai-compatible";

// 百炼的模型列表里还有语音、画图、向量、翻译、角色扮演、内部测试模型，这些不能用来跑提示词，不列出
const NOT_CHAT = /embedding|rerank|wanx|wan2|cosyvoice|paraformer|sambert|speech|gummy|asr|tts|realtime|livetranslate|image|video|audio|flux|stable-diffusion|-mt-|character|deep-research|deep-search|gui-plus|math|sre-gpu|^test-/i;
// 带日期的固定快照（如 qwen-plus-2025-07-14、qwen-max-0107）和不带日期的同名模型重复，不列出
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;
const TTL_MS = 10 * 60_000;

let list: { at: number; key: string; models: string[] } | null = null;

/** 保存或清除模型设置后调用，让下次重新读取模型列表 */
export function resetModelListCache() {
  list = null;
}

/** 可选模型：默认模型（.env.local 的 MODEL_NAME 或网页设置的模型）排第一，其余按名字排序；读取失败时只有默认模型，并附上原因 */
export async function availableModels(): Promise<{ default: string; models: string[]; error: string | null }> {
  const p = getProvider();
  const def = p.info().model;
  let error: string | null = null;
  const key = p instanceof OpenAICompatibleProvider ? p.endpointKey() : "";
  if (p instanceof OpenAICompatibleProvider && (!list || list.key !== key || Date.now() - list.at > TTL_MS)) {
    try {
      list = { at: Date.now(), key, models: (await p.listModels()).filter((m) => !NOT_CHAT.test(m) && !DATED.test(m)).sort() };
    } catch (e) {
      error = redactSecrets(e instanceof Error ? e.message : String(e));
    }
  }
  const rest = (list?.models ?? []).filter((m) => m !== def);
  return { default: def, models: def ? [def, ...rest] : rest, error };
}

/** 运行前确认模型在服务商的可用列表里，不把任意字符串当模型名发出去 */
export async function isAvailableModel(model: string): Promise<boolean> {
  return (await availableModels()).models.includes(model);
}
