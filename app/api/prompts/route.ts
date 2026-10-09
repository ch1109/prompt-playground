import { handle, ok } from "@/lib/api/respond";
import { DEFAULT_PROJECT_ID, listPrompts } from "@/lib/repositories/prompts";

export const GET = (req: Request) =>
  handle(() => ok(listPrompts(new URL(req.url).searchParams.get("project") ?? DEFAULT_PROJECT_ID)));
