"use client";
import type { Layout, StoredLayout } from "@/lib/layouts/types";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** 统一处理 {ok,data}/{ok:false,error}；请求失败与业务校验失败分开展示 */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: init?.json !== undefined ? init.method ?? "POST" : init?.method,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  let body: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  try {
    body = await res.json();
  } catch {
    throw new ApiError("NETWORK_OR_SERVER_ERROR", `服务端返回非 JSON（HTTP ${res.status}）`, res.status);
  }
  if (!body.ok) throw new ApiError(body.error?.code ?? "UNKNOWN", body.error?.message ?? "请求失败", res.status, body.error?.details);
  return body.data as T;
}

export const getLayout = (promptId: string) => api<{ layout: StoredLayout | null }>(`/api/prompts/${encodeURIComponent(promptId)}/layout`);
export const saveLayout = (promptId: string, layout: Layout) => api<StoredLayout>(`/api/prompts/${encodeURIComponent(promptId)}/layout`, { method: "PUT", json: { layout } });
/** 让 AI 生成版式（只返回不保存）。未确认外发时抛 ApiError（code=EGRESS_NOT_CONFIRMED，details.provider_host），由上层弹确认后重试 */
export const generateLayout = (promptId: string, input: { run_id: string; want?: string; model?: string }) =>
  api<{ layout: Layout }>(`/api/prompts/${encodeURIComponent(promptId)}/layout/generate`, { method: "POST", json: input });
