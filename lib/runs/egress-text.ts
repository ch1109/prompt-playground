import type { Run } from "@/lib/contracts/run";

/** 外发记录的一句话说明：发往 <host> · 文字、图片 · 由 <用户> 授权 */
export function describeEgress(e: NonNullable<Run["egress"]>): string {
  const by = e.authorized_by.startsWith("web:") ? e.authorized_by.slice(4) : e.authorized_by.startsWith("agent:") ? `智能体 ${e.authorized_by.slice(6)}（令牌授权）` : "未知";
  return `发往 ${e.provider_host} · ${e.kinds.map((k) => (k === "image" ? "图片" : "文字")).join("、")} · 由 ${by} 授权`;
}
