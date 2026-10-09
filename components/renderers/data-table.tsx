"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TableRow, TableView } from "@/lib/contracts/view-model";
import { useStudio } from "@/lib/state/studio-store";
import { Badge, CellValue, cx, Empty } from "@/components/ui";

export interface DataTableOptions {
  frozenColumns?: string[];
  fieldPreset?: "core" | "all";
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
}

const FIXED_W = 132;

export function DataTable({ table, options = {} }: { table: TableView; options?: DataTableOptions }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const hasCore = table.columns.some((c) => c.core !== undefined);
  const [preset, setPreset] = useState<"core" | "all">(options.fieldPreset ?? "all");
  const [q, setQ] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const frozen = useMemo(() => new Set([...(options.frozenColumns ?? []), ...table.columns.filter((c) => c.fixed).map((c) => c.key)]), [options.frozenColumns, table.columns]);
  const columns = useMemo(() => {
    const cols = table.columns.filter((c) => !hasCore || preset === "all" || c.core || frozen.has(c.key));
    // 固定列排在最前
    return [...cols.filter((c) => frozen.has(c.key)), ...cols.filter((c) => !frozen.has(c.key))];
  }, [table.columns, hasCore, preset, frozen]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return table.rows.filter((r) => {
      if (options.rowFilter && !options.rowFilter(r)) return false;
      if (!needle) return true;
      return Object.values(r.cells).some((c) => String(c.value ?? "").toLowerCase().includes(needle)) || r.id.toLowerCase().includes(needle);
    });
  }, [table.rows, q, options]);

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

  const frozenLeft = (key: string) => columns.filter((c) => frozen.has(c.key)).findIndex((c) => c.key === key) * FIXED_W;

  return (
    <div data-table-id={table.id} className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-1.5">
        {!options.hideTitle && <span className="text-[12px] font-semibold text-ink-100">{table.title}</span>}
        <Badge>{rows.length === table.rows.length ? `${rows.length} 行` : `${rows.length}/${table.rows.length} 行`}</Badge>
        {hasCore && (
          <div className="flex overflow-hidden rounded border border-ink-600 text-[11px]">
            {(["core", "all"] as const).map((p) => (
              <button key={p} onClick={() => setPreset(p)} className={cx("px-2 py-0.5", preset === p ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-100")}>
                {p === "core" ? "核心字段" : `全部 ${table.columns.length - 1} 字段`}
              </button>
            ))}
          </div>
        )}
        {options.toolbar}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛选…"
          aria-label={`筛选 ${table.title}`}
          className="ml-auto w-36 rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-[12px] outline-none focus:border-ink-400"
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
                      "sticky top-0 z-10 border-b border-r border-ink-700 bg-ink-850 px-2 py-1 text-left font-medium whitespace-nowrap text-ink-300",
                      frozen.has(c.key) && "z-20",
                    )}
                    style={frozen.has(c.key) ? { left: frozenLeft(c.key), minWidth: FIXED_W, maxWidth: FIXED_W } : { minWidth: 96 }}
                  >
                    {c.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rowSelected = sel.tableId === table.id && sel.rowId === r.id;
                return (
                  <tr
                    key={r.id}
                    data-row-id={r.id}
                    onClick={() => options.onRowSelect?.(r)}
                    className={cx("group", rowSelected && "bg-stamp/[0.07]", options.highlightRowIds?.has(r.id) && "bg-info/[0.08]")}
                  >
                    {columns.map((c) => {
                      const cell = r.cells[c.key];
                      const cellSelected = rowSelected && sel.fieldKey === c.key;
                      return (
                        <td
                          key={c.key}
                          data-field={c.key}
                          onClick={() => {
                            if (!cell) return;
                            select({ tableId: table.id, rowId: r.id, fieldKey: c.key, jsonPointer: cell.jsonPointer, sourceRefId: cell.sourceRefIds[0] ?? r.sourceRefIds?.[0] });
                            setStore("evidenceOpen", true);
                          }}
                          className={cx(
                            "cursor-pointer border-b border-r border-ink-800 px-2 py-1 align-top group-hover:bg-ink-800/60",
                            options.dense ? "max-w-[220px]" : "max-w-[320px]",
                            frozen.has(c.key) && "sticky z-[5] bg-ink-900",
                            cellSelected && "outline outline-2 -outline-offset-2 outline-stamp flash",
                          )}
                          style={frozen.has(c.key) ? { left: frozenLeft(c.key), minWidth: FIXED_W, maxWidth: FIXED_W } : undefined}
                          title={cell ? `${cell.jsonPointer}${cell.sourceRefIds.length ? `  · ${cell.sourceRefIds.length} 个来源` : "  · 未提供来源"}` : undefined}
                        >
                          <div className="flex items-start gap-1 break-words">
                            {cell ? <CellValue value={cell.value} state={cell.state} kind={c.kind} /> : <span className="text-ink-700">—</span>}
                            {cell && cell.sourceRefIds.length > 0 && <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-verify/70" aria-label="有来源" />}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
