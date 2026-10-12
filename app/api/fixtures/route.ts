import { handle, ok } from "@/lib/api/respond";
import { listFixtures, ORIGIN_LABEL, summarize } from "@/lib/fixtures/catalog";
import { fixtureRunStats } from "@/lib/repositories/runs";

/**
 * 样本列表。带 ?project= 时附上该项目里的运行统计；没有请求 / Gold / 基准草稿的样本不建快照，
 * 无法关联运行，stats 为 null（界面显示「—」并说明原因）。
 */
export const GET = (req: Request) =>
  handle(() => {
    const project = new URL(req.url).searchParams.get("project");
    const stats = project ? fixtureRunStats(project) : null;
    const items = listFixtures().map((f) => ({
      ...summarize(f),
      stats: stats && (f.request || f.gold || f.baseDraft) ? (stats.get(f.id) ?? { run_count: 0, last_run_at: null, wrong_count: 0 }) : null,
    }));
    return ok({ items, originLabels: ORIGIN_LABEL });
  });
