"use client";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { IssueView, TableRow, TableView } from "@/lib/contracts/view-model";
import { useAnnotatedPointers, useStudio } from "@/lib/state/studio-store";
import { Badge, CellValue, cx, Empty } from "@/components/ui";
import { stateLabel } from "@/lib/adapters/helpers";

export interface DataTableOptions {
  frozenColumns?: string[];
  fieldPreset?: "core" | "all";
  /** 「核心 / 全部」切换按钮的文字；默认「核心字段 / 全部 N 字段」（P1 首列是序号，不计入字段数） */
  presetLabels?: [string, string];
  /** 外部行过滤（例如按入仓号分组、按委托行筛候选） */
  rowFilter?: (row: TableRow) => boolean;
  /** 额外的工具栏控件 */
  toolbar?: React.ReactNode;
  maxHeight?: number;
  dense?: boolean;
  /** 行点击（不是单元格）时的回调，例如 P3 选中委托行 */
  onRowSelect?: (row: TableRow) => void;
  highlightRowIds?: Set<string>;
  hideTitle?: boolean;
  /** 行可展开：在行下方列出全部字段（有问题的排前面），点字段同点单元格 */
  expandable?: boolean;
  /** 受控的「只看有问题的行」（结果精简状态里的按钮也能切换） */
  onlyIssues?: boolean;
  onOnlyIssuesChange?: (v: boolean) => void;
}

const FIXED_W = 132;

/** 当前 ViewModel 的问题列表：表格据此给被问题指向的单元格加角标（BusinessView 提供） */
export const IssuesContext = createContext<IssueView[]>([]);

type SortState = { key: string; dir: 1 | -1 } | null;

/** 排序只改变显示顺序：数字按数值、其余按文本；每个单元格的 JSON Pointer 不变 */
function compareCells(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && a !== null && b !== null && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""), "zh-CN");
}

export function DataTable({ table, options = {} }: { table: TableView; options?: DataTableOptions }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const annotated = useAnnotatedPointers();
  const allIssues = useContext(IssuesContext);
  const hasCore = table.columns.some((c) => c.core !== undefined);
  const [preset, setPreset] = useState<"core" | "all">(options.fieldPreset ?? "all");
  const [q, setQ] = useState("");
  const [qField, setQField] = useState("");
  const [ownOnlyIssues, setOwnOnlyIssues] = useState(false);
  const onlyIssues = options.onlyIssues ?? ownOnlyIssues;
  const setOnlyIssues = options.onOnlyIssuesChange ?? setOwnOnlyIssues;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => setExpanded((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])));
  const [sort, setSort] = useState<SortState>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // 指向本表单元格 / 行的问题（按 行|字段 索引；没有字段的记在行上）
  const issueIndex = useMemo(() => {
    const m = new Map<string, IssueView[]>();
    for (const i of allIssues) {
      if (i.target?.tableId !== table.id || !i.target.rowId) continue;
      const k = `${i.target.rowId}|${i.target.fieldKey ?? ""}`;
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return m;
  }, [allIssues, table.id]);
  const issueRows = useMemo(() => new Set([...issueIndex.keys()].map((k) => k.split("|")[0])), [issueIndex]);
  const issueFields = useMemo(() => new Set([...issueIndex.keys()].map((k) => k.split("|")[1]).filter(Boolean)), [issueIndex]);

  const frozen = useMemo(() => new Set([...(options.frozenColumns ?? []), ...table.columns.filter((c) => c.fixed).map((c) => c.key)]), [options.frozenColumns, table.columns]);
  const columns = useMemo(() => {
    // 「核心字段」也保留被问题指向的字段，冲突列不会被隐藏
    const cols = table.columns.filter((c) => !hasCore || preset === "all" || c.core || frozen.has(c.key) || issueFields.has(c.key));
    // 固定列排在最前
    return [...cols.filter((c) => frozen.has(c.key)), ...cols.filter((c) => !frozen.has(c.key))];
  }, [table.columns, hasCore, preset, frozen, issueFields]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = table.rows.filter((r) => {
      if (options.rowFilter && !options.rowFilter(r)) return false;
      if (onlyIssues && !issueRows.has(r.id)) return false;
      if (!needle) return true;
      // 状态格子界面显示中文（英文在悬停提示），所以两种都能筛
      const text = (v: unknown) => `${String(v ?? "")} ${stateLabel(String(v ?? "")).label}`.toLowerCase();
      if (qField) return text(r.cells[qField]?.value).includes(needle);
      return Object.values(r.cells).some((c) => text(c.value).includes(needle)) || r.id.toLowerCase().includes(needle);
    });
    if (sort) out.sort((a, b) => sort.dir * compareCells(a.cells[sort.key]?.value, b.cells[sort.key]?.value));
    return out;
  }, [table.rows, q, qField, onlyIssues, issueRows, sort, options]);

  // 选中对象变化时滚动到对应行（定位依赖行 ID，不依赖当前序号）
  useEffect(() => {
    if (sel.tableId !== table.id || !sel.rowId || !scroller.current) return;
    const el = scroller.current.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(sel.rowId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (sel.fieldKey) {
      const cell = el?.querySelector<HTMLElement>(`[data-field="${CSS.escape(sel.fieldKey)}"]`);
      cell?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [sel.tableId, sel.rowId, sel.fieldKey, table.id]);

  const pickCell = (r: TableRow, key: string) => {
    const cell = r.cells[key];
    if (!cell) return;
    const fieldTitle = table.columns.find((c) => c.key === key)?.title;
    const place = [table.title, `第 ${table.rows.indexOf(r) + 1} 行`, fieldTitle].filter(Boolean).join(" · ");
    select({ tableId: table.id, rowId: r.id, fieldKey: key, jsonPointer: cell.jsonPointer, sourceRefId: cell.sourceRefIds[0] ?? r.sourceRefIds?.[0], place, fieldTitle });
    setStore("evidenceOpen", true);
  };

  const frozenLeft = (key: string) => columns.filter((c) => frozen.has(c.key)).findIndex((c) => c.key === key) * FIXED_W;

  return (
    <div data-table-id={table.id} className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3.5 py-2">
        {!options.hideTitle && <span className="text-[12px] font-semibold text-ink-100">{table.title}</span>}
        <Badge>{rows.length === table.rows.length ? `${rows.length} 行` : `${rows.length}/${table.rows.length} 行`}</Badge>
        {hasCore && (
          <div className="flex gap-0.5 rounded-lg bg-ink-800 p-0.5 text-[11.5px]">
            {(["core", "all"] as const).map((p) => (
              <button key={p} onClick={() => setPreset(p)} className={cx("px-2.5 py-0.5", preset === p ? "rounded-md bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
                {options.presetLabels ? options.presetLabels[p === "core" ? 0 : 1] : p === "core" ? "核心字段" : `全部 ${table.columns.length - 1} 字段`}
              </button>
            ))}
          </div>
        )}
        {options.toolbar}
        {issueRows.size > 0 && (
          <label className="flex items-center gap-1 text-[11.5px] text-ink-300">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} aria-label={`只看有问题的行 ${table.title}`} />
            只看有问题的行（{issueRows.size}）
          </label>
        )}
        {sort && (
          <button onClick={() => setSort(null)} className="text-[11px] text-info hover:underline" title="恢复为模型输出的原始顺序">
            按「{table.columns.find((c) => c.key === sort.key)?.title}」{sort.dir === 1 ? "升序" : "降序"} ✕
          </button>
        )}
        <select value={qField} onChange={(e) => setQField(e.target.value)} aria-label={`筛选字段 ${table.title}`} className="ml-auto max-w-32 rounded-lg border border-ink-700 bg-ink-900 px-1 py-1 text-[11.5px]">
          <option value="">全部列</option>
          {table.columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.title}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛选…"
          aria-label={`筛选 ${table.title}`}
          className="w-40 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-[12px] outline-none focus:border-ink-400"
        />
      </div>
      {rows.length === 0 ? (
        <Empty>{table.rows.length ? "没有符合筛选条件的行" : "没有数据"}</Empty>
      ) : (
        <div ref={scroller} className="min-h-0 overflow-auto" style={{ maxHeight: options.maxHeight ?? 420 }}>
          <table className="border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={cx(
                      "sticky top-0 z-10 border-b border-ink-700 bg-ink-850 px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-ink-400",
                      frozen.has(c.key) && "z-20",
                    )}
                    style={frozen.has(c.key) ? { left: frozenLeft(c.key), minWidth: FIXED_W, maxWidth: FIXED_W } : { minWidth: 96 }}
                    aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  >
                    <button
                      onClick={() => setSort((s) => (s?.key !== c.key ? { key: c.key, dir: 1 } : s.dir === 1 ? { key: c.key, dir: -1 } : null))}
                      className="inline-flex items-center gap-0.5 hover:text-ink-100"
                      title="点击排序（升序 → 降序 → 原始顺序）；排序不改变定位"
                      data-sort-key={c.key}
                    >
                      {c.title}
                      {sort?.key === c.key && <span>{sort.dir === 1 ? "↑" : "↓"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rowSelected = sel.tableId === table.id && sel.rowId === r.id;
                const open = options.expandable && expanded.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr
                      data-row-id={r.id}
                      onClick={() => options.onRowSelect?.(r)}
                      className={cx("group", rowSelected && "bg-accent/[0.06]", options.highlightRowIds?.has(r.id) && "bg-info/[0.08]")}
                    >
                      {columns.map((c, ci) => {
                        const cell = r.cells[c.key];
                        const cellSelected = rowSelected && sel.fieldKey === c.key;
                        const cellIssues = issueIndex.get(`${r.id}|${c.key}`);
                        return (
                          <td
                            key={c.key}
                            data-field={c.key}
                            data-annotated={cell && annotated.has(cell.jsonPointer) ? "" : undefined}
                            onClick={() => pickCell(r, c.key)}
                            className={cx(
                              "cursor-pointer border-b border-ink-800 px-3 py-1.5 align-top whitespace-nowrap transition-colors group-hover:bg-ink-850",
                              options.dense ? "max-w-[200px]" : "max-w-[240px]",
                              frozen.has(c.key) && cx("sticky z-[5]", rowSelected ? "bg-[color-mix(in_srgb,var(--color-accent)_6%,white)]" : "bg-ink-900 group-hover:bg-ink-850"),
                              cellSelected && "outline outline-2 -outline-offset-2 outline-accent flash",
                            )}
                            style={frozen.has(c.key) ? { left: frozenLeft(c.key), minWidth: FIXED_W, maxWidth: FIXED_W } : undefined}
                            title={cell ? `${typeof cell.value === "object" ? JSON.stringify(cell.value) : String(cell.value ?? "")}\n${cell.sourceRefIds.length ? `${cell.sourceRefIds.length} 个来源，点击查看` : "模型没有提供来源"}` : undefined}
                          >
                            <div className="flex min-w-0 items-center gap-1">
                              {options.expandable && ci === 0 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleRow(r.id);
                                  }}
                                  className="shrink-0 rounded px-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                                  aria-label={open ? "收起全部字段" : "展开全部字段"}
                                  aria-expanded={open}
                                  data-testid="row-expand"
                                >
                                  {open ? "▾" : "▸"}
                                </button>
                              )}
                              <span className="min-w-0 truncate">{cell ? <CellValue value={cell.value} state={cell.state} kind={c.kind} /> : <span className="text-ink-700">—</span>}</span>
                              {cellIssues && (
                                <span
                                  className="shrink-0 rounded-md bg-risk/15 px-1 text-[10px] leading-4 text-risk"
                                  title={cellIssues.map((i) => `${i.type}：${i.summary}${i.detail ? `\n${i.detail}` : ""}`).join("\n")}
                                  data-testid="cell-issue"
                                >
                                  {cellIssues.some((i) => /CONFLICT/.test(i.type)) ? "冲突" : "问题"}
                                </span>
                              )}
                              {cell && annotated.has(cell.jsonPointer) && (
                                <span className="shrink-0 rounded-md bg-info/15 px-1 text-[10px] leading-4 text-info" title="已有标注（见右侧「来源与标注」）">
                                  标
                                </span>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    {open && (
                      <tr data-expanded-for={r.id}>
                        <td colSpan={columns.length} className="border-b border-ink-700 bg-ink-850 p-0">
                          <RowFields table={table} row={r} issueIndex={issueIndex} selectedKey={rowSelected ? sel.fieldKey : undefined} onPick={(k) => pickCell(r, k)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 展开行：全部字段两列网格（有问题的字段排在最前），点字段等同点单元格 */
function RowFields({ table, row, issueIndex, selectedKey, onPick }: { table: TableView; row: TableRow; issueIndex: Map<string, IssueView[]>; selectedKey?: string; onPick: (key: string) => void }) {
  const cols = [...table.columns].sort((a, b) => Number(issueIndex.has(`${row.id}|${b.key}`)) - Number(issueIndex.has(`${row.id}|${a.key}`)));
  return (
    <div className="sticky left-0 grid max-w-[920px] grid-cols-2 gap-x-6 gap-y-0.5 px-4 py-2.5 text-[12px]" data-testid="row-fields">
      {cols.map((c) => {
        const cell = row.cells[c.key];
        const issues = issueIndex.get(`${row.id}|${c.key}`);
        return (
          <button
            key={c.key}
            onClick={() => onPick(c.key)}
            disabled={!cell}
            data-field={c.key}
            className={cx("flex min-w-0 items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-ink-800 disabled:cursor-default", selectedKey === c.key && "bg-accent/[0.08] ring-1 ring-accent/40")}
          >
            <span className="w-24 shrink-0 text-ink-400">{c.title}</span>
            <span className="min-w-0 break-words">{cell ? <CellValue value={cell.value} state={cell.state} kind={c.kind} /> : <span className="text-ink-700">—</span>}</span>
            {issues && <span className="shrink-0 rounded-md bg-risk/15 px-1 text-[10px] leading-4 text-risk">{issues.some((i) => /CONFLICT/.test(i.type)) ? "冲突" : "问题"}</span>}
          </button>
        );
      })}
    </div>
  );
}
