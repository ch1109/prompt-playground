import { fail } from "@/lib/api/respond";
import { getProvider } from "@/lib/models/openai-compatible";
import { hasEgressConsent } from "@/lib/repositories/egress";

/** 网页发起真实模型运行前的外发确认检查：已配置模型、且本项目还没确认过这个服务商地址 → 409。通过返回 null。未配置模型交给运行服务报原来的错 */
export function egressGate(projectId: string, model?: string | null): Response | null {
  const info = getProvider(model).info();
  if (!info.configured) return null;
  const host = info.baseUrlHost ?? info.provider;
  if (hasEgressConsent(projectId, host)) return null;
  return fail("EGRESS_NOT_CONFIRMED", `第一次把材料发给 ${host}，需要先确认`, 409, { provider_host: host });
}
