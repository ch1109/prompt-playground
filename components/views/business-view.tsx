"use client";
import { useMemo, useState } from "react";
import type { RendererConfig, RendererRegion } from "@/lib/contracts/renderer-config";
import type { ChangeView, TableRow, TableView, ViewModel } from "@/lib/contracts/view-model";
import { UNRESOLVED_GROUP } from "@/lib/adapters/jiuli-p2";
import { useStudio } from "@/lib/state/studio-store";
import { DataTable, IssuesContext, type DataTableOptions } from "@/components/renderers/data-table";
import { FieldDiff } from "@/components/renderers/field-diff";
import { IssueList } from "@/components/renderers/issue-list";
import { RelationCanvas } from "@/components/renderers/relation-canvas";
import { SummaryStrip } from "@/components/renderers/summary-strip";
import { Badge, Btn, cx, Section } from "@/components/ui";

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

/** 表名去掉括号里的补充说明，用于一句话概括 */
const shortTitle = (t: string) => t.replace(/（.*$/, "");

// ---------------- P1：第一屏只有 主表 + 待处理问题；合计、读取情况、统计折叠 ----------------
function WideTableLayout({ vm, cfg, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; onlyIssues: boolean; setOnlyIssues: (v: boolean) => void }) {
  const tableRegions = cfg.regions.filter((r) => r.component === "data-table");
  const secondary = tableRegions
    .slice(1)
    .map((r) => ({ region: r, table: resolveTable(vm, r.binding) }))
    .filter((x): x is { region: RendererRegion; table: TableView } => !!x.table);
  const strip = cfg.regions.filter((r) => r.component === "summary-strip");
  return (
    <div className="space-y-3">
      {tableRegions.slice(0, 1).map((r) => <Region key={r.id} region={r} vm={vm} extra={{ maxHeight: 460, expandable: true, onlyIssues, onOnlyIssuesChange: setOnlyIssues }} />)}
      {vm.issues.length ? (
        cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)
      ) : (
        <p className="rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2 text-[12.5px] text-ink-300" data-testid="no-issues">
          模型没有报告问题。<span className="text-ink-400">这不代表字段都正确，请抽查关键字段。</span>
        </p>
      )}
      {secondary.length > 0 && (
        <details className="rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900" data-testid="secondary-details">
          <summary className="cursor-pointer px-3.5 py-2 text-[12.5px]">
            <span className="font-semibold text-ink-100">合计与读取情况</span>
            <span className="ml-2 text-ink-400">{secondary.map(({ table }) => `${shortTitle(table.title)} ${table.rows.length ? `${table.rows.length} 条` : "无"}`).join(" · ")}</span>
          </summary>
          <div className="space-y-3 border-t border-ink-700/70 p-3">
            {secondary.map(({ region, table }) =>
              table.rows.length ? (
                <Region key={region.id} region={region} vm={vm} />
              ) : (
                <p key={region.id} className="text-[12px] text-ink-400">
                  {table.title}：没有记录。
                </p>
              ),
            )}
          </div>
        </details>
      )}
      {strip.length > 0 && (
        <details className="rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900" data-testid="more-stats">
          <summary className="cursor-pointer px-3.5 py-2 text-[12.5px] font-semibold text-ink-100">更多统计</summary>
          <div className="border-t border-ink-700/70 p-3">
            {strip.map((r) => (
              <Region key={r.id} region={r} vm={vm} />
            ))}
          </div>
        </details>
      )}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P2：入仓号分组 → 合并产品 → 原始行 ----------------
function HierarchyLayout({ vm, cfg, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; onlyIssues: boolean; setOnlyIssues: (v: boolean) => void }) {
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
                options={{ hideTitle: true, rowFilter: (r) => inGroup(r) && (!members || members.has(String(r.cells.local_raw_row_ref?.value ?? r.id))), highlightRowIds: undefined, onlyIssues, onOnlyIssuesChange: setOnlyIssues }}
              />
            </Section>
          )}
          {scopes && (
            <details className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900" data-testid="p2-scope-details">
              <summary className="cursor-pointer px-3.5 py-2 text-[12.5px]" title="技术记录：output.scope_records">
                <span className="font-semibold text-ink-100">合计与覆盖范围</span>
                <span className="ml-2 text-ink-400">{scopes.rows.filter(inGroup).length ? `${scopes.rows.filter(inGroup).length} 条（原值不累计、不平均）` : "无"}</span>
              </summary>
              <div className="border-t border-ink-700/70">
                <DataTable table={scopes} options={{ hideTitle: true, rowFilter: inGroup, maxHeight: 200 }} />
              </div>
            </details>
          )}
        </div>
      </div>
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P3：委托行 | 候选表/关系图 | 证据 ----------------
function CandidateLayout({ vm, cfg, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; onlyIssues: boolean; setOnlyIssues: (v: boolean) => void }) {
  const regions = byId(cfg);
  const orders = vm.tables.find((t) => t.id === "orderRows");
  const cands = vm.tables.find((t) => t.id === "candidateGroups");
  const pool = regions.has("pool") ? vm.tables.find((t) => t.id === "requestCandidates") : undefined;
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
              <DataTable table={orders} options={{ hideTitle: true, dense: true, maxHeight: 520, highlightRowIds: new Set(current ? [current] : []), onlyIssues, onOnlyIssuesChange: setOnlyIssues }} />
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
      {pool && (
        <Section title="请求候选池（召回诊断：模型实际收到的全部候选）" className="overflow-hidden">
          <DataTable table={pool} options={{ hideTitle: true, maxHeight: 320, highlightRowIds: new Set(pool.rows.filter((r) => !r.meta?.mentioned).map((r) => r.id)) }} />
        </Section>
      )}
      {cfg.regions.filter((r) => r.component === "issue-list").map((r) => <Region key={r.id} region={r} vm={vm} />)}
      <OtherTables vm={vm} cfg={cfg} />
    </div>
  );
}

// ---------------- P4：决策表 + Patch 预览 ----------------
function DecisionLayout({ vm, cfg, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; onlyIssues: boolean; setOnlyIssues: (v: boolean) => void }) {
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
          <DataTable table={decisions} options={{ hideTitle: true, rowFilter, toolbar, frozenColumns: ["order_row_id", "field"], onlyIssues, onOnlyIssuesChange: setOnlyIssues }} />
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

export interface HeadlineProps {
  /** 运行状态与模式：区分「模型运行成功」「示例结果」，以及结构是否完全符合 */
  status: string;
  mode: string;
  /** 下一步动作 */
  onCompare?: () => void;
  onEditPrompt?: () => void;
}

/**
 * 结果区第一屏的精简状态：运行是否成功、主表多少行、模型报告了几个问题、准确性能否评测。
 * 明确把"模型运行成功"和"识别结果正确"分开：没有标准答案时写「准确性未评测」。
 */
export function ResultHeadline({ vm, cfg, status, mode, onCompare, onEditPrompt, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; onlyIssues?: boolean; setOnlyIssues?: (v: boolean) => void } & HeadlineProps) {
  const h = vm.metadata?.headline;
  const mainId = cfg.regions.find((r) => r.component === "data-table")?.binding.slice(7);
  const main = vm.tables.find((t) => t.id === mainId);
  const run = mode === "MODEL_RUN" ? (status === "SCHEMA_INVALID" ? "模型运行成功，但结构不完全符合约定" : "模型运行成功") : mode === "REPLAY" ? "历史结果重新整理" : "示例 / 粘贴结果（未调用模型）";
  // 模型自己报告的问题与规则 / 结构检查发现的分开计数（§4.2），不混成一个「问题数」
  const modelIssues = vm.issues.filter((i) => i.origin === "MODEL_FINDING").length;
  const otherIssues = vm.issues.length - modelIssues;
  return (
    <div className="rise flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-[12.5px]" data-testid="result-headline">
      <span className={cx("font-semibold", status === "SCHEMA_INVALID" ? "text-risk" : "text-ink-100")}>{run}</span>
      {main && (
        <span>
          <b className="text-ink-100">{main.rows.length}</b> 条{h?.entity ?? "记录"}
        </span>
      )}
      <span>
        <b className={cx(modelIssues ? "text-risk" : "text-ink-100")}>{modelIssues}</b> 条模型报告问题
      </span>
      {otherIssues > 0 && (
        <span title="来自规则、结构校验或整理过程，不是模型自己报告的">
          <b className="text-risk">{otherIssues}</b> 条规则 / 结构提示
        </span>
      )}
      {h?.gold ? (
        <Badge tone="ok">已对照标准答案</Badge>
      ) : (
        <span className="text-ink-400" title="没有独立的标准答案（Gold），问题数 0 不代表字段都正确">
          <Badge tone="warn">准确性未评测</Badge> 没有标准答案
        </span>
      )}
      {h && (
        <span className="text-ink-300">
          客户 <b className="text-ink-100">{h.customerName || "未识别"}</b>
          {h.customerId && <span className="ml-1 font-mono text-[11px] text-ink-400">{h.customerId}</span>}
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-1.5" data-testid="headline-actions">
        {setOnlyIssues && vm.issues.length > 0 && (
          <Btn onClick={() => setOnlyIssues(!onlyIssues)} aria-pressed={onlyIssues} data-testid="btn-only-issues">
            {onlyIssues ? "显示全部行" : "只看有问题的行"}
          </Btn>
        )}
        {onCompare && (
          <Btn onClick={onCompare} title="选两次运行，看改提示词前后差在哪">
            对比历史运行
          </Btn>
        )}
        {onEditPrompt && (
          <Btn onClick={onEditPrompt} title="切到提示词调试：左边改提示词，右边看结果">
            编辑提示词
          </Btn>
        )}
      </span>
    </div>
  );
}

export function BusinessView({ vm, cfg, canPreview, ...headline }: { vm: ViewModel; cfg: RendererConfig; canPreview: boolean } & HeadlineProps) {
  // 「只看有问题的行」作用于各布局的主表（P1 委托行、P2 原始行、P3 委托商品、P4 字段决策）
  const [onlyIssues, setOnlyIssues] = useState(false);
  return (
    <IssuesContext.Provider value={vm.issues}>
      <div className="space-y-3">
        <ResultHeadline vm={vm} cfg={cfg} {...headline} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />
        <Layout vm={vm} cfg={cfg} canPreview={canPreview} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />
      </div>
    </IssuesContext.Provider>
  );
}

function Layout({ vm, cfg, onlyIssues, setOnlyIssues }: { vm: ViewModel; cfg: RendererConfig; canPreview: boolean; onlyIssues: boolean; setOnlyIssues: (v: boolean) => void }) {
  switch (cfg.layout) {
    case "wide-table-with-issues":
      return <WideTableLayout vm={vm} cfg={cfg} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />;
    case "hierarchy-with-issues":
      return <HierarchyLayout vm={vm} cfg={cfg} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />;
    case "candidate-comparison":
      return <CandidateLayout vm={vm} cfg={cfg} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />;
    case "field-decisions-and-patch":
      return <DecisionLayout vm={vm} cfg={cfg} onlyIssues={onlyIssues} setOnlyIssues={setOnlyIssues} />;
    default:
      return <p className="text-stamp">未知布局 {cfg.layout}</p>;
  }
}
