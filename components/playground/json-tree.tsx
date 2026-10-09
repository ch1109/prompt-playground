"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { escapeToken, isWithin } from "@/lib/pipeline/json-pointer";
import { cx } from "@/components/ui";

interface Props {
  value: unknown;
  highlight?: string;
  onSelect?: (pointer: string) => void;
}

const PAGE = 200;

function preview(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).length}}`;
  return "";
}

const Node = memo(function Node({ name, value, pointer, depth, highlight, onSelect }: { name: string | null; value: unknown; pointer: string; depth: number; highlight?: string; onSelect?: (p: string) => void }) {
  const isContainer = value !== null && typeof value === "object";
  const onPath = highlight !== undefined && isWithin(highlight, pointer);
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(PAGE);
  const ref = useRef<HTMLDivElement>(null);
  const isHit = highlight === pointer;

  // 选中路径上的祖先自动展开
  useEffect(() => {
    if (onPath && isContainer) setOpen(true);
  }, [onPath, isContainer]);
  useEffect(() => {
    if (isHit) ref.current?.scrollIntoView({ block: "center" });
  }, [isHit]);

  const entries = isContainer ? (Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object)) : [];

  return (
    <div>
      <div
        ref={ref}
        data-pointer={pointer}
        onClick={(e) => {
          e.stopPropagation();
          if (isContainer) setOpen((o) => !o);
          onSelect?.(pointer);
        }}
        className={cx("flex cursor-pointer items-start gap-1 rounded-sm px-1 hover:bg-ink-800", isHit && "bg-stamp/25 ring-1 ring-stamp flash")}
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="w-3 shrink-0 text-ink-600">{isContainer ? (open ? "▾" : "▸") : ""}</span>
        {name !== null && <span className="shrink-0 text-info">{JSON.stringify(name)}:</span>}
        {isContainer ? (
          <span className="text-ink-400">{preview(value)}</span>
        ) : (
          <span className={cx("break-all whitespace-pre-wrap", typeof value === "string" ? "text-verify" : typeof value === "number" ? "text-risk" : "text-stamp")}>{JSON.stringify(value)}</span>
        )}
      </div>
      {isContainer && open && (
        <>
          {entries.slice(0, limit).map(([k, v]) => (
            <Node key={k} name={Array.isArray(value) ? null : k} value={v} pointer={`${pointer}/${escapeToken(k)}`} depth={depth + 1} highlight={onPath ? highlight : undefined} onSelect={onSelect} />
          ))}
          {entries.length > limit && (
            <button onClick={() => setLimit((l) => l + PAGE)} className="text-[11px] text-info" style={{ paddingLeft: (depth + 1) * 14 + 16 }}>
              显示更多（剩余 {entries.length - limit}）
            </button>
          )}
        </>
      )}
    </div>
  );
});

export function JsonTree({ value, highlight, onSelect }: Props) {
  return (
    <div className="font-mono text-[12px] leading-5">
      <Node name={null} value={value} pointer="" depth={0} highlight={highlight} onSelect={onSelect} />
    </div>
  );
}

/** JSON 不合法时展示原文 + 错误位置；不生成任何表格 */
export function RawText({ text, errorLine }: { text: string; errorLine?: number }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("[data-error-line]")?.scrollIntoView({ block: "center" });
  }, [errorLine]);
  return (
    <div ref={ref} className="font-mono text-[12px] leading-5">
      {lines.map((l, i) => (
        <div key={i} data-error-line={errorLine === i + 1 ? "" : undefined} className={cx("flex", errorLine === i + 1 && "bg-stamp/20")}>
          <span className="w-10 shrink-0 pr-2 text-right text-ink-600 select-none">{i + 1}</span>
          <span className="break-all whitespace-pre-wrap">{l || " "}</span>
        </div>
      ))}
    </div>
  );
}
