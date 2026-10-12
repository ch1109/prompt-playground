import type { ModelParams, TokenUsage } from "@/lib/contracts/run";

export interface ModelRequest {
  system: string;
  user: string;
  params: ModelParams;
  /** 随用户消息附带的页面图片（视觉模型）；ref 用于在请求记录里指明是哪个原件的哪一页 */
  images?: { mediaType: string; base64: string; ref?: { file_id: string; page: number | null; sha256: string } }[];
  signal?: AbortSignal;
}

/**
 * request：实际发给服务商的请求结构（脱敏副本）。文本只记字符数与 sha256、图片只记原件引用，
 * 不含 API Key、不含图片 base64；没发出请求（如未配置）时不提供。
 */
export type ModelResult =
  | { ok: true; raw: string; usage: TokenUsage | null; latencyMs: number; responseMeta: Record<string, unknown>; request?: Record<string, unknown> }
  | { ok: false; code: string; message: string; latencyMs: number; partialRaw?: string; request?: Record<string, unknown> };

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
  /** 流式输出：本适配器只用非流式 */
  streaming: false;
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
}

export interface ProviderAdapter {
  info(): ProviderInfo;
  complete(req: ModelRequest): Promise<ModelResult>;
}
