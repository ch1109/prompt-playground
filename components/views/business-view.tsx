"use client";
import { useMemo, useState } from "react";
import type { RendererConfig, RendererRegion } from "@/lib/contracts/renderer-config";
import type { ChangeView, TableRow, TableView, ViewModel } from "@/lib/contracts/view-model";
import { UNRESOLVED_GROUP } from "@/lib/adapters/jiuli-p2";
import { useStudio } from "@/lib/state/studio-store";
import { DataTable, type DataTableOptions } from "@/components/renderers/data-table";
import { FieldDiff } from "@/components/renderers/field-diff";
import { IssueList } from "@/components/renderers/issue-list";
import { RelationCanvas } from "@/components/renderers/relation-canvas";
import { SummaryStrip } from "@/components/renderers/summary-strip";
import { Badge, cx, Section } from "@/components/ui";

/** binding 是登记的逻辑选择器：tables.<id> 选择 ViewModel.tables 中 id 相同的表，不执行任何表达式 */
function resolveTable(vm: ViewModel, binding: string): TableView | undefined {
  return binding.startsWith("tables.") ? vm.tables.find((t) => t.id === binding.slice(7)) : undefined;
}

function boundTableIds(cfg: RendererConfig) {
  return new Set(cfg.regions.filter((r) => r.binding.startsWith("tables.")).map((r) => r.binding.slice(7)));
}

/** 白名单组件分发 */
function Region({ region, vm, extra }: { region: RendererRegion; vm: ViewModel; extra?: DataTableOptions }) {
  const opts = (region.options ?? {}) as Record<string, unknown>;
  switch (region.component) {
    case "data-table": {
      const t = resolveTable(vm, region.binding);
      if (!t) return null; // 绑定的表不存在（例如本次输出无该部分）→ 安全隐藏
      return (
        <Section title={t.title} className="overflow-hidden">
          <DataTable
            table={t}
            options={{ frozenColumns: opts.frozenColumns as string[] | undefined, fieldPreset: opts.fieldPreset as "core" | "all" | undefined, hideTitle: true, ...extra }}
          />
        </Section>
      );
    }
    case "issue-list":
      return (
        <Section title="问题与风险" className="overflow-hidden">
          <IssueList issues={vm.issues} />
        </Section>
      );
    case "summary-strip":
      return <SummaryStrip items={vm.metadata?.summary} notes={vm.metadata?.notes} />;
    case "field-diff":
      return (
        <Section title="字段差异" className="overflow-hidden">
          <FieldDiff changes={vm.changes} />
        </Section>
      );
    case "relation-canvas":
      return (
        <Section title="关系图" className="overflow-hidden">
          <RelationCanvas relations={vm.relations} />
        </Section>
      );
    default:
      // evidence-viewer 在抽屉中渲染；run-metadata 在"运行信息"标签
      return null;
  }
}

function OtherTables({ vm, cfg }: { vm: ViewModel; cfg: RendererConfig }) {
  const bound = boundTableIds(cfg);
  const rest = vm.tables.filter((t) => !bound.has(t.id));
  if (!rest.length) return null;
  return (
    <>
      {rest.map((t) => (
        <Section key={t.id} title={`其他输出 · ${t.title}`} className="overflow-hidden">
          <DataTable table={t} options={{ hideTitle: true }} />
        </Section>
      ))}
    </>
  );
}

function byId(cfg: RendererConfig) {
  return new Map(cfg.regions.map((r) => [r.id, r]));
}

// ---------------- P1：宽表 + 问题区 ----------------
function WideTableLayout({ vm, cfg }: { vm: ViewModel; cfg: RendererConfig }) {
  const tableRegions = cfg.regions.filter((r) => r.component === "data-table");
  return (
    <div className="space-y-3">
      {cfg.regions.filter((r) => r.component === "summary-strip").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      {tableRegions.slice(0, 1).map((r) => <Region key={r.id} region={r} vm={vm} extra={{ maxHeight: 460 }} />)}
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      {tableRegions.slice(1).map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P2：入仓号分组 → 合并产品 → 原始行 ----------------
function HierarchyLayout({ vm, cfg }: { vm: ViewModel; cfg: RendererConfig }) {
  const regions = byId(cfg);
  const li = vm.tables.find((t) => t.id === "logicalInspections");
  const merged = vm.tables.find((t) => t.id === "mergedProducts");
  const raw = vm.tables.find((t) => t.id === "inspectionRawRows");
  const scopes = vm.tables.find((t) => t.id === "scopeRecords");
  const groups = useMemo(() => {
    const g = new Map<string, { label: string; count: number }>();
    for (const r of li?.rows ?? []) g.set(String(r.meta?.group), { label: String(r.meta?.group) || "（空）", count: 0 });
    for (const r of raw?.rows ?? []) {
      const k = String(r.meta?.group);
      const cur = g.get(k) ?? { label: k === UNRESOLVED_GROUP ? "未确定入仓号" : k, count: 0 };
      cur.count++;
      g.set(k, cur);
    }
    return [...g.entries()].map(([key, v]) => ({ key, ...v, label: key === UNRESOLVED_GROUP ? "未确定入仓号" : v.label }));
  }, [li, raw]);
  const sel = useStudio((s) => s.selection);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [mergedSel, setMergedSel] = useState<string | null>(null);
  // 选中对象在某个分组里时，自动切换到该分组（例如点击问题定位）
  const selectedGroup = useMemo(() => {
    const t = vm.tables.find((x) => x.id === sel.tableId);
    const row = t?.rows.find((r) => r.id === sel.rowId);
    return row?.meta?.group !== undefined ? String(row.meta.group) : null;
  }, [vm.tables, sel.tableId, sel.rowId]);
  const activeGroup = selectedGroup ?? group ?? groups[0]?.key ?? null;
  const members = mergedSel ? new Set((merged?.rows.find((r) => r.id === mergedSel)?.meta?.members as string[]) ?? []) : null;
  const inGroup = (r: TableRow) => String(r.meta?.group) === activeGroup;

  return (
    <div className="space-y-3">
      {regions.get("summary") && <Region region={regions.get("summary")!} vm={vm} />}
      <div className="grid grid-cols-[200px_1fr] gap-3">
        <Section title="入仓号">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="查找入仓号…" aria-label="查找入仓号" className="m-2 w-[calc(100%-16px)] rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5 text-[12px] outline-none" />
          <ul className="max-h-[520px] overflow-auto pb-1">
            {groups
              .filter((g) => !q || g.label.includes(q))
              .map((g) => (
                <li key={g.key}>
                  <button
                    data-group={g.key}
                    onClick={() => {
                      setGroup(g.key);
                      setMergedSel(null);
                      useStudio.getState().clearSelection();
                    }}
                    className={cx("flex w-full items-center justify-between px-3 py-1 text-left font-mono text-[12px] hover:bg-ink-800", activeGroup === g.key && "bg-accent/[0.07] text-accent")}
                  >
                    <span className={cx(g.key === UNRESOLVED_GROUP && "font-sans text-risk")}>{g.label}</span>
                    <Badge>{g.count}</Badge>
                  </button>
                </li>
              ))}
          </ul>
        </Section>
        <div className="min-w-0 space-y-3">
          {activeGroup === UNRESOLVED_GROUP && <p className="rounded-lg border border-risk/40 bg-risk/10 px-3 py-1.5 text-[12px] text-risk">以下原始行没有可靠入仓号：原样展示，不归入任何逻辑查货单，也不伪造入仓号。</p>}
          {li && (
            <Section title={li.title} className="overflow-hidden">
              <DataTable table={li} options={{ hideTitle: true, rowFilter: inGroup, maxHeight: 160 }} />
            </Section>
          )}
          {merged && (
            <Section title={`${merged.title}（点击行展开组成原始行）`} className="overflow-hidden">
              <DataTable table={merged} options={{ hideTitle: true, rowFilter: inGroup, maxHeight: 200, onRowSelect: (r) => setMergedSel((cur) => (cur === r.id ? null : r.id)) }} />
            </Section>
          )}
          {raw && (
            <Section
              title={raw.title}
              right={members && <button onClick={() => setMergedSel(null)} className="text-[11px] text-info">只看 {mergedSel} 的组成行 ✕</button>}
              className="overflow-hidden"
            >
              <DataTable
                table={raw}
                options={{ hideTitle: true, rowFilter: (r) => inGroup(r) && (!members || members.has(String(r.cells.local_raw_row_ref?.value ?? r.id))), highlightRowIds: undefined }}
              />
            </Section>
          )}
          {scopes && (
            <Section title={scopes.title} className="overflow-hidden">
              <DataTable table={scopes} options={{ hideTitle: true, rowFilter: inGroup, maxHeight: 200 }} />
            </Section>
          )}
        </div>
      </div>
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P3：委托行 | 候选表/关系图 | 证据 ----------------
function CandidateLayout({ vm, cfg }: { vm: ViewModel; cfg: RendererConfig }) {
  const regions = byId(cfg);
  const orders = vm.tables.find((t) => t.id === "orderRows");
  const cands = vm.tables.find((t) => t.id === "candidateGroups");
  const sel = useStudio((s) => s.selection);
  const showGraphDefault = Boolean((regions.get("relations")?.options as { defaultVisible?: boolean } | undefined)?.defaultVisible);
  const [mode, setMode] = useState<"table" | "graph">(showGraphDefault ? "graph" : "table");
  const [all, setAll] = useState(false);
  const selectedRow = sel.relationId ? vm.relations.find((r) => r.id === sel.relationId)?.fromId : sel.tableId === "orderRows" ? sel.rowId : sel.tableId === "candidateGroups" ? String(cands?.rows.find((r) => r.id === sel.rowId)?.meta?.orderRowId ?? "") : undefined;
  const current = selectedRow || orders?.rows[0]?.id;

  return (
    <div className="space-y-3">
      {regions.get("summary") && <Region region={regions.get("summary")!} vm={vm} />}
      {/* 左：委托商品；中：候选表/关系图；右：证据详情由右侧「来源与标注」栏承担（与全局选择联动） */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-3 @[860px]:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.4fr)]">
          {orders && (
            <Section title="委托商品（点击行查看候选）" className="min-w-0 overflow-hidden">
              <DataTable table={orders} options={{ hideTitle: true, dense: true, maxHeight: 520, highlightRowIds: new Set(current ? [current] : []) }} />
            </Section>
          )}
          <Section
            title={current ? `候选 · ${current}` : "候选"}
            right={
              <div className="flex items-center gap-2 whitespace-nowrap">
                <label className="flex items-center gap-1 text-[11px] text-ink-400">
                  <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} aria-label="显示全部委托行" /> 全部
                </label>
                <div className="flex gap-0.5 rounded-lg bg-ink-800 p-0.5 text-[11.5px]">
                  {(["table", "graph"] as const).map((m) => (
                    <button key={m} onClick={() => setMode(m)} className={cx("px-2.5 py-0.5", mode === m ? "rounded-md bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
                      {m === "table" ? "候选表" : "关系图"}
                    </button>
                  ))}
                </div>
              </div>
            }
            className="min-w-0 overflow-hidden"
          >
            {mode === "table" && cands && !all && !cands.rows.some((r) => r.meta?.orderRowId === current) ? (
              <p className="px-3 py-4 text-[12px] text-ink-400">
                模型没有为 {current} 给出选中组或候选（{String(orders?.rows.find((r) => r.id === current)?.cells.match_status?.value ?? "")}）。原样展示，不推断原因。
              </p>
            ) : (
              mode === "table" && cands && <DataTable table={cands} options={{ hideTitle: true, rowFilter: all ? undefined : (r) => r.meta?.orderRowId === current, maxHeight: 520 }} />
            )}
            {mode === "graph" && <RelationCanvas relations={vm.relations} onlyFrom={all ? undefined : current} />}
          </Section>
        </div>
      </div>
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P4：决策表 + Patch 预览 ----------------
function DecisionLayout({ vm, cfg }: { vm: ViewModel; cfg: RendererConfig }) {
  const regions = byId(cfg);
  const decisions = vm.tables.find((t) => t.id === "fieldDecisions");
  const presets = ((regions.get("decisions")?.options as { filterPresets?: string[] } | undefined)?.filterPresets ?? ["all", "changes", "risks"]) as ("all" | "changes" | "risks")[];
  const [preset, setPreset] = useState<"all" | "changes" | "risks">("all");
  const LABEL = { all: "全部字段", changes: "只看变化", risks: "仅风险" };
  const rowFilter = (r: TableRow) => preset === "all" || (preset === "changes" ? !!r.meta?.changed : !!r.meta?.risk);
  const changeFilter = (c: ChangeView) => {
    const row = decisions?.rows.find((r) => r.id === c.id);
    return row ? rowFilter(row) : true;
  };
  const toolbar = (
    <div className="flex gap-0.5 rounded-lg bg-ink-800 p-0.5 text-[11.5px]">
      {presets.map((p) => (
        <button key={p} data-preset={p} onClick={() => setPreset(p)} className={cx("px-2.5 py-0.5", preset === p ? "rounded-md bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
          {LABEL[p]}
        </button>
      ))}
    </div>
  );
  return (
    <div className="space-y-3">
      {regions.get("summary") && <Region region={regions.get("summary")!} vm={vm} />}
      {decisions && (
        <Section title={decisions.title} className="overflow-hidden">
          <DataTable table={decisions} options={{ hideTitle: true, rowFilter, toolbar, frozenColumns: ["order_row_id", "field"] }} />
        </Section>
      )}
      {regions.get("changes") && (
        <Section title="字段差异" className="overflow-hidden">
          <FieldDiff changes={vm.changes} filter={changeFilter} />
        </Section>
      )}
      {cfg.regions
        .filter((r) => r.component === "data-table" && r.id !== "decisions")
        .map((r) => (
          <Region key={r.id} region={r} vm={vm} />
        ))}
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

export function BusinessView({ vm, cfg, canPreview }: { vm: ViewModel; cfg: RendererConfig; canPreview: boolean }) {
  switch (cfg.layout) {
    case "wide-table-with-issues":
      return <WideTableLayout vm={vm} cfg={cfg} />;
    case "hierarchy-with-issues":
      return <HierarchyLayout vm={vm} cfg={cfg} />;
    case "candidate-comparison":
      return <CandidateLayout vm={vm} cfg={cfg} />;
    case "field-decisions-and-patch":
      return <DecisionLayout vm={vm} cfg={cfg} />;
    default:
      return <p className="text-stamp">未知布局 {cfg.layout}</p>;
  }
}
