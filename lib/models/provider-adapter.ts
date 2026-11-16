import type { ModelParams, TokenUsage } from "@/lib/contracts/run";

export interface ModelRequest {
  system: string;
  user: string;
  params: ModelParams;
  /** 随用户消息附带的页面图片（视觉模型）；ref 用于在请求记录里指明是哪个原件的哪一页 */
  images?: { mediaType: string; base64: string; ref?: { file_id: string; page: number | null; sha256: string } }[];
  signal?: AbortSignal;
  /**
   * 传了就流式接收：每收到一段新内容回调一次（累计的思考与回答全文），超时改为「多久没有新内容」；
   * 不传则一次性返回，超时是总时长。
   */
  onProgress?: (p: { content: string; reasoning: string }) => void;
}

/**
 * request：实际发给服务商的请求结构（脱敏副本）。文本只记字符数与 sha256、图片只记原件引用，
 * 不含 API Key、不含图片 base64；没发出请求（如未配置）时不提供。
 */
export type ModelResult =
  | { ok: true; raw: string; usage: TokenUsage | null; latencyMs: number; responseMeta: Record<string, unknown>; request?: Record<string, unknown>; /** 模型的思考内容全文（服务商返回时才有） */ reasoning?: string | null }
  | { ok: false; code: string; message: string; latencyMs: number; partialRaw?: string; /** 流式中途失败时已收到的思考内容 */ partialReasoning?: string; request?: Record<string, unknown> };

/**
 * 模型能力声明（R-04）。OpenAI 兼容网关无法自动探测，由 .env.local 显式声明；
 * null = 未声明（未知），界面如实显示「未声明」，不当作支持。
 */
export interface ProviderCapabilities {
  images: boolean | null;
  /** 原生 PDF 直传：本适配器不支持 */
  nativePdf: false;
  jsonMode: boolean | null;
  thinking: boolean | null;
  /** 流式输出：OpenAI 兼容适配器在运行时流式接收；服务商不支持时按一次性返回处理 */
  streaming: boolean;
  maxOutputTokens: number | null;
}

export interface ProviderInfo {
  provider: string;
  model: string;
  configured: boolean;
  /** 是否支持把原始文件（PDF/Excel/图片）直接发给模型；首版 OpenAI 兼容网关只发文本 */
  supportsFileInput: boolean;
  adapterVersion: string;
  baseUrlHost?: string;
  capabilities: ProviderCapabilities;
  /** 超时（毫秒）：流式时指多久没有新内容 */
  timeoutMs?: number;
}

export interface ProviderAdapter {
  info(): ProviderInfo;
  complete(req: ModelRequest): Promise<ModelResult>;
}
