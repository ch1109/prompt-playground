"use client";
import type { LayoutResult } from "@/lib/layouts/types";
import { DataTable } from "@/components/renderers/data-table";
import { IssueList } from "@/components/renderers/issue-list";
import { LayoutCards } from "@/components/renderers/layout-cards";
import { LayoutReport } from "@/components/renderers/layout-report";
import { Section } from "@/components/ui";

export function LayoutView({ result }: { result: LayoutResult }) {
  return (
    <div data-testid="layout-view" data-kind={result.kind} className="space-y-3">
      {result.kind === "table" && (
        <Section title={result.table.title} className="overflow-hidden">
          <DataTable table={result.table} options={{ hideTitle: true }} />
        </Section>
      )}
      {result.kind === "checklist" && (
        <>
          <p className="text-[12.5px] text-ink-300">
            通过 {result.passCount} · 未通过 {result.failCount}
          </p>
          <Section title="检查结果" className="overflow-hidden">
            <IssueList issues={result.issues} />
          </Section>
        </>
      )}
      {result.kind === "cards" && <LayoutCards cards={result.cards} />}
      {result.kind === "report" && <LayoutReport sections={result.sections} markdown={result.markdown} />}
      {result.kind === "mismatch" && (
        <div className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px] text-info">版式没对上这次的输出：{result.reason}</div>
      )}
    </div>
  );
}
