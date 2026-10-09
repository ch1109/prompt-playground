import { describe, expect, it } from "vitest";
import { listFixtures } from "@/lib/fixtures/catalog";
import { runPipeline } from "@/lib/pipeline/pipeline";

describe("全部 fixture 冒烟", () => {
  for (const f of listFixtures()) {
    it(f.id, () => {
      const r = runPipeline({ raw: f.raw, promptKind: f.promptKind, context: { runId: "t", request: f.request, gold: f.gold, baseDraft: f.baseDraft } });
      const vm = r.viewModel;
      console.log(
        `${f.id.padEnd(48)} ${r.status.padEnd(15)} ${r.validation.status.padEnd(14)} tables=${vm?.tables.map((t) => `${t.id}:${t.rows.length}`).join(",") ?? "-"} issues=${vm?.issues.length ?? "-"} rel=${vm?.relations.length ?? "-"} ev=${vm?.evidence.length ?? "-"} diag=${r.diagnostics.filter((d) => d.level !== "INFO").map((d) => d.code).slice(0, 6).join(",")}`,
      );
      expect(r.status).not.toBe("ADAPTER_ERROR");
    });
  }
});
