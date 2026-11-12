import { rejectForeignOrigin } from "@/lib/api/origin";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { getProvider } from "@/lib/models/openai-compatible";
import { getEgressConsent, recordEgressConsent } from "@/lib/repositories/egress";
import { DEFAULT_PROJECT_ID, listProjects } from "@/lib/repositories/prompts";

function status(projectId: string) {
  const info = getProvider().info();
  const host = info.configured ? (info.baseUrlHost ?? info.provider) : "";
  const consent = host ? getEgressConsent(projectId, host) : undefined;
  return { provider_host: host, configured: info.configured, confirmed: !!consent, confirmed_at: consent?.confirmed_at ?? null };
}

export const GET = (req: Request) => handle(() => ok(status(new URL(req.url).searchParams.get("project") ?? DEFAULT_PROJECT_ID)));

/** 记录「同意把材料发给这个服务商地址」；只能确认当前正在用的地址 */
export const POST = (req: Request) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true, "确认外发");
    if (denied) return denied;
    const b = await body<{ project_id?: unknown; provider_host?: unknown }>(req);
    if (typeof b.project_id !== "string" || typeof b.provider_host !== "string") return fail("BAD_REQUEST", "缺少 project_id 或 provider_host");
    if (!listProjects().some((p) => p.project_id === b.project_id)) return fail("PROJECT_NOT_FOUND", "项目不存在", 404);
    const cur = status(b.project_id);
    if (!cur.configured) return fail("MODEL_NOT_CONFIGURED", "还没设置模型，无需确认");
    if (b.provider_host !== cur.provider_host) return fail("PROVIDER_HOST_MISMATCH", `当前模型服务地址是 ${cur.provider_host}，不是 ${b.provider_host}，请刷新后重新确认`, 409);
    const c = recordEgressConsent(b.project_id, cur.provider_host, process.env.STUDIO_USER || "本机用户");
    return ok({ ...cur, confirmed: true, confirmed_at: c.confirmed_at });
  });
