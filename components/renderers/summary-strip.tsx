"use client";
import type { SummaryItem } from "@/lib/contracts/view-model";

/** 只读确定性统计；没有 summary 扩展时安全隐藏 */
export function SummaryStrip({ items, notes }: { items?: SummaryItem[]; notes?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="rise">
      <div className="flex flex-wrap gap-2">
        {items.map((it, i) => (
          <div key={it.label} className="rise min-w-[136px] flex-1 rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]" style={{ animationDelay: `${i * 40}ms` }} title={it.hint}>
            <div className="text-[11px] text-ink-400">{it.label}</div>
            <div className="mt-0.5 text-[14.5px] font-semibold tracking-tight break-words text-ink-100">{it.value}</div>
          </div>
        ))}
      </div>
      {notes?.map((n) => (
        <p key={n} className="mt-1.5 text-[11px] text-ink-400">
          ※ {n}
        </p>
      ))}
    </div>
  );
}
