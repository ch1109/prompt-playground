"use client";
import type { LayoutCard } from "@/lib/layouts/types";
import { useStudio } from "@/lib/state/studio-store";
import { Badge, cx } from "@/components/ui";

export function LayoutCards({ cards }: { cards: LayoutCard[] }) {
  const selected = useStudio((s) => s.selection.jsonPointer);
  const select = useStudio((s) => s.select);
  return (
    <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3" data-testid="layout-cards">
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => select({ jsonPointer: c.pointer, place: c.title || "（无标题）" })}
          data-card-id={c.id}
          className={cx(
            "min-w-0 rounded-xl border bg-ink-900 p-3 text-left transition-colors hover:bg-ink-850",
            selected === c.pointer ? "border-accent bg-accent/[0.06]" : "border-ink-700",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-[13px] font-semibold break-words whitespace-pre-wrap text-ink-100">{c.title || "（空）"}</span>
            {c.badge && <Badge tone="mute" className="shrink-0">{c.badge}</Badge>}
          </div>
          {c.fields.length > 0 && (
            <dl className="mt-2 space-y-1 text-[12px]">
              {c.fields.map((f, i) => (
                <div key={`${f.pointer}-${i}`} className="flex min-w-0 gap-2">
                  <dt className="w-20 shrink-0 text-ink-400">{f.label}</dt>
                  <dd className="min-w-0 flex-1 break-words whitespace-pre-wrap">{f.value === "" ? <span className="text-ink-600">（空）</span> : f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </button>
      ))}
    </div>
  );
}
