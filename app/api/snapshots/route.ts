import { handle, ok } from "@/lib/api/respond";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { listSnapshots } from "@/lib/repositories/snapshots";

export const GET = (req: Request) => handle(() => ok(listSnapshots(new URL(req.url).searchParams.get("project") ?? DEFAULT_PROJECT_ID)));
