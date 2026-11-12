"use client";
import { useState } from "react";
import type { LayoutSection } from "@/lib/layouts/types";
import { Btn } from "@/components/ui";

function Body({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-0.5 text-[12.5px] leading-relaxed break-words">
      {lines.map((l, i) =>
        /^- /.test(l) ? (
          <div key={i} className="flex gap-1.5 pl-2">
            <span className="text-ink-400">•</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{l.slice(2)}</span>
          </div>
        ) : (
          <div key={i} className="whitespace-pre-wrap">{l}</div>
        ),
      )}
    </div>
  );
}

export function LayoutReport({ sections, markdown }: { sections: LayoutSection[]; markdown: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };
  return (
    <div className="p-3.5" data-testid="layout-report">
      <div className="mb-2 flex justify-end">
        <Btn tone="outline" onClick={copy}>
          {copied ? "已复制" : "复制全文"}
        </Btn>
      </div>
      <div className="space-y-4">
        {sections
          .filter((s) => s.found)
          .map((s, i) => (
            <section key={`${s.pointer}-${i}`}>
              <h4 className="mb-1 text-[12.5px] font-semibold text-ink-100">{s.title}</h4>
              <Body text={s.text} />
            </section>
          ))}
      </div>
    </div>
  );
}
