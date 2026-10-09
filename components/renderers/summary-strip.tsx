"use client";
import type { SummaryItem } from "@/lib/contracts/view-model";

/** 只读确定性统计；没有 summary 扩展时安全隐藏 */
export function SummaryStrip({ items, notes }: { items?: SummaryItem[]; notes?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="rise">
      <div className="flex flex-wrap gap-px overflow-hidden rounded-md border border-ink-700 bg-ink-700">
        {items.map((it, i) => (
          <div key={it.label} className="min-w-[96px] flex-1 bg-ink-900 px-3 py-1.5" style={{ animationDelay: `${i * 40}ms` }} title={it.hint}>
            <div className="text-[10.5px] text-ink-400">{it.label}</div>
            <div className="font-mono text-[15px] text-ink-100">{it.value}</div>
          </div>
        ))}
      </div>
      {notes?.map((n) => (
        <p key={n} className="mt-1 text-[11px] text-ink-400">
          ※ {n}
        </p>
      ))}
    </div>
  );
}
