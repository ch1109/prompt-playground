import { handle, ok } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";

export const GET = () => handle(async () => ok(await getJiuliConnector().capabilities()));
