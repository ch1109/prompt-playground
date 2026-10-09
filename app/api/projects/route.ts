import { handle, ok } from "@/lib/api/respond";
import { listProjects } from "@/lib/repositories/prompts";

export const GET = () => handle(() => ok(listProjects()));
