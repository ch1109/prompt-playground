import { fail, handle, ok } from "@/lib/api/respond";
import { getFixture } from "@/lib/fixtures/catalog";

export const GET = (req: Request) =>
  handle(() => {
    const f = getFixture(new URL(req.url).searchParams.get("id") ?? "");
    return f ? ok(f) : fail("FIXTURE_NOT_FOUND", "样本不存在", 404);
  });
