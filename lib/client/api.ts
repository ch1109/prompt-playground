"use client";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
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
  let body: { ok: boolean; data?: T; error?: { code: string; message: string } };
  try {
    body = await res.json();
  } catch {
    throw new ApiError("NETWORK_OR_SERVER_ERROR", `服务端返回非 JSON（HTTP ${res.status}）`, res.status);
  }
  if (!body.ok) throw new ApiError(body.error?.code ?? "UNKNOWN", body.error?.message ?? "请求失败", res.status);
  return body.data as T;
}
