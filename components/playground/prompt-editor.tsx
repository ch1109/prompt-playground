"use client";
import { useMemo, useRef, useState } from "react";
import { TEMPLATE_VARIABLES, unresolvedVariables } from "@/lib/input-builders";
import { Btn, cx } from "@/components/ui";

/** 规则目录：Markdown 标题、「一、」式章节、【】标题（不解析正文条目，避免目录过长） */
const HEADING = /^\s*(#{1,6}\s+\S.*|[一二三四五六七八九十]+、\S.*|【[^】]+】.*)$/;

export function promptOutline(text: string): { line: number; title: string; offset: number }[] {
  const out: { line: number; title: string; offset: number }[] = [];
  let offset = 0;
  text.split("\n").forEach((l, i) => {
    if (HEADING.test(l)) out.push({ line: i + 1, title: l.trim().replace(/^#+\s*/, ""), offset });
    offset += l.length + 1;
  });
  return out;
}

/** 所有匹配的起始位置（不区分大小写） */
export function findAll(text: string, q: string): number[] {
  if (!q) return [];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * System 提示词编辑区（R-06）：沿用 textarea，补全文搜索、规则目录（带行号、可收起）、光标所在行与变量检查。
 * 跳转用 setSelectionRange 选中目标后聚焦，浏览器会把选区滚入可视区。
 */
export function PromptEditor({ system, userTemplate, onSystem }: { system: string; userTemplate: string; onSystem: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const [tocOpen, setTocOpen] = useState(true);
  const [cursorLine, setCursorLine] = useState(1);
  const outline = useMemo(() => promptOutline(system), [system]);
  const matches = useMemo(() => findAll(system, q), [system, q]);
  const unresolved = useMemo(() => unresolvedVariables(system, userTemplate), [system, userTemplate]);
  const usesInput = userTemplate.includes("{{input_json}}") || system.includes("{{input_json}}");
  const totalLines = system.split("\n").length;

  function jump(start: number, end: number) {
    const el = ref.current;
    if (!el) return;
    el.blur();
    el.setSelectionRange(start, end);
    el.focus();
    setCursorLine(lineOf(system, start));
  }
  function go(dir: 1 | -1) {
    if (!matches.length) return;
    const next = (hit + dir + matches.length) % matches.length;
    setHit(next);
    jump(matches[next], matches[next] + q.length);
  }

  return (
    <div className="space-y-1.5" data-testid="prompt-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHit(-1);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go(e.shiftKey ? -1 : 1))}
          placeholder="在提示词中搜索（Enter 下一个，Shift+Enter 上一个）"
          aria-label="搜索提示词"
          className="min-w-48 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] outline-none focus:border-ink-400"
        />
        {q && (
          <span className="text-[11.5px] text-ink-400" data-testid="search-count">
            {matches.length ? `${hit >= 0 ? hit + 1 : 0}/${matches.length} 处${hit >= 0 ? ` · 第 ${lineOf(system, matches[hit])} 行` : ""}` : "没有匹配"}
          </span>
        )}
        <Btn onClick={() => go(-1)} disabled={!matches.length} aria-label="上一个匹配">
          ↑
        </Btn>
        <Btn onClick={() => go(1)} disabled={!matches.length} aria-label="下一个匹配">
          ↓
        </Btn>
        <Btn onClick={() => setTocOpen((v) => !v)} aria-pressed={tocOpen}>
          {tocOpen ? "收起目录" : `规则目录（${outline.length}）`}
        </Btn>
      </div>
      <div className={cx("grid gap-2", tocOpen && outline.length ? "grid-cols-[180px_1fr]" : "grid-cols-1")}>
        {tocOpen && outline.length > 0 && (
          <nav aria-label="规则目录" className="max-h-[38vh] overflow-auto rounded-lg border border-ink-700 bg-ink-900 py-1 text-[11.5px]">
            {outline.map((h) => (
              <button
                key={h.line}
                onClick={() => jump(h.offset, h.offset + h.title.length)}
                className={cx("flex w-full gap-1.5 px-2 py-0.5 text-left hover:bg-ink-800", cursorLine >= h.line && !outline.some((x) => x.line > h.line && x.line <= cursorLine) && "bg-accent/[0.07] text-accent")}
                title={h.title}
              >
                <span className="w-7 shrink-0 text-right font-mono text-[10.5px] text-ink-400">{h.line}</span>
                <span className="truncate">{h.title}</span>
              </button>
            ))}
          </nav>
        )}
        <textarea
          ref={ref}
          value={system}
          onChange={(e) => onSystem(e.target.value)}
          onSelect={(e) => setCursorLine(lineOf(system, e.currentTarget.selectionStart))}
          aria-label="System 提示词"
          spellCheck={false}
          className="h-[38vh] w-full resize-y rounded-lg border border-ink-700 bg-ink-900 p-2 font-mono text-[12.5px] leading-6 outline-none focus:border-ink-400"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-400">
        <span data-testid="cursor-line">
          第 {cursorLine} 行 / 共 {totalLines} 行 · {system.length.toLocaleString()} 字
        </span>
        <span className={cx(unresolved.length ? "text-stamp" : usesInput ? "text-verify" : "text-risk")} data-testid="variable-check">
          {unresolved.length
            ? `未登记变量 ${unresolved.join("、")}：运行会被阻止（只支持 ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join("、")}）`
            : usesInput
              ? "变量检查通过：{{input_json}} 会替换为构造好的请求 JSON"
              : "模板里没有 {{input_json}}：模型将收不到输入数据"}
        </span>
      </div>
    </div>
  );
}
