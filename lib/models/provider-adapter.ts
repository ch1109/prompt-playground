import type { ModelParams, TokenUsage } from "@/lib/contracts/run";

export interface ModelRequest {
  system: string;
  user: string;
  params: ModelParams;
  signal?: AbortSignal;
}

export type ModelResult =
  | { ok: true; raw: string; usage: TokenUsage | null; latencyMs: number; responseMeta: Record<string, unknown> }
  | { ok: false; code: string; message: string; latencyMs: number; partialRaw?: string };

export interface ProviderInfo {
  provider: string;
  model: string;
  configured: boolean;
  /** 是否支持把原始文件（PDF/Excel/图片）直接发给模型；首版 OpenAI 兼容网关只发文本 */
  supportsFileInput: boolean;
  adapterVersion: string;
  baseUrlHost?: string;
}

export interface ProviderAdapter {
  info(): ProviderInfo;
  complete(req: ModelRequest): Promise<ModelResult>;
}
