import { api, ApiError } from "@/lib/client/api";

/** 页面里的外发确认弹窗（EgressConfirmDialog）登记在这里；询问时由它显示，用户点了再 resolve */
export type EgressAsk = { host: string; resolve: (ok: boolean) => void };
let listener: ((a: EgressAsk) => void) | null = null;

export function onEgressAsk(l: (a: EgressAsk) => void): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** 弹窗没挂上时按「不同意」处理：什么都不发 */
const ask = (host: string) => new Promise<boolean>((resolve) => (listener ? listener({ host, resolve }) : resolve(false)));

/** 发起会把材料发给模型服务商的请求；服务端说这个地址还没确认过，就弹确认框，同意后记录并自动再发一次。不同意返回 null（什么都不做） */
export async function withEgressConfirm<T>(projectId: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (e) {
    const host = e instanceof ApiError && e.code === "EGRESS_NOT_CONFIRMED" ? (e.details as { provider_host?: string } | undefined)?.provider_host : undefined;
    if (!host) throw e;
    if (!(await ask(host))) return null;
    await api("/api/egress", { json: { project_id: projectId, provider_host: host } });
    return call();
  }
}
