import { handle, ok } from "@/lib/api/respond";
import { listFixtures, ORIGIN_LABEL, summarize } from "@/lib/fixtures/catalog";

export const GET = () => handle(() => ok({ items: listFixtures().map(summarize), originLabels: ORIGIN_LABEL }));
