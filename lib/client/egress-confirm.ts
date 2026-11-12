import { api, ApiError } from "@/lib/client/api";

/** 发起会把材料发给模型服务商的请求；服务端说这个地址还没确认过，就弹确认框，同意后记录并自动再发一次。不同意返回 null（什么都不做） */
export async function withEgressConfirm<T>(projectId: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (e) {
    const host = e instanceof ApiError && e.code === "EGRESS_NOT_CONFIRMED" ? (e.details as { provider_host?: string } | undefined)?.provider_host : undefined;
    if (!host) throw e;
    if (!window.confirm(`第一次把材料发给 ${host}。\n\n这次运行会把输入的文字内容（勾选「附带原件图片」时还包括原件页面图片）发送给这个模型服务商，其中可能有客户资料。\n\n确认后，本项目以后发往这个地址不再询问。`)) return null;
    await api("/api/egress", { json: { project_id: projectId, provider_host: host } });
    return call();
  }
}
