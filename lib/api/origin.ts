import { fail } from "@/lib/api/respond";

/** 修改类请求的来源校验：防止别的网站（或被劫持域名指向本机的页面）偷偷改配置。通过返回 null，否则返回 403 */
export function rejectForeignOrigin(req: Request, needJson: boolean, action = "修改模型设置"): Response | null {
  const msg = `只允许从本机页面${action}`;
  const deny = (m: string) => fail("FORBIDDEN_ORIGIN", m, 403);
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return deny(msg);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return deny(msg);
  }
  if (url.host !== host.toLowerCase() || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) return deny(msg);
  if (needJson && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return deny("请求格式不对");
  return null;
}
