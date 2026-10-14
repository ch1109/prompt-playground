"use client";
import { createElement, useMemo, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
 * 阅读视图用的 Markdown：九立提示词多用「一、」「【】」做章节标题，显示时升为 Markdown 标题。
 * 只在行首加 #，不增删行，渲染后的行号与原文一致（目录跳转靠它）。原文本身不改。
 */
export function readableMarkdown(text: string): string {
  return text
    .split("\n")
    .map((l) => (/^\s*[一二三四五六七八九十]+、\S/.test(l) ? `## ${l.trim()}` : /^\s*【[^】]+】/.test(l) ? `### ${l.trim()}` : l))
    .join("\n");
}

/** 标题带上原文行号，目录点击时据此滚动到位 */
const heading =
  (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  ({ node, ...rest }: ComponentProps<typeof tag> & ExtraProps) =>
    createElement(tag, { ...rest, "data-line": node?.position?.start.line });
const MD_COMPONENTS: Components = { h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6") };

/**
 * System 提示词（R-06）：「编辑」是原文 textarea（搜索、光标行、变量检查）；「阅读」按 Markdown 渲染，只看不改。
 * 两种模式共用规则目录：编辑时选中并滚到该行，阅读时滚到对应标题。可一键复制全文。
 */
export function PromptEditor({ system, userTemplate, onSystem }: { system: string; userTemplate: string; onSystem: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"edit" | "read">("edit");
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const [tocOpen, setTocOpen] = useState(true);
  const [cursorLine, setCursorLine] = useState(1);
  const [copied, setCopied] = useState(false);
  const outline = useMemo(() => promptOutline(system), [system]);
  const matches = useMemo(() => findAll(system, q), [system, q]);
  const unresolved = useMemo(() => unresolvedVariables(system, userTemplate), [system, userTemplate]);
  const markdown = useMemo(() => readableMarkdown(system), [system]);
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
  function goHeading(h: { line: number; title: string; offset: number }) {
    if (view === "edit") return jump(h.offset, h.offset + h.title.length);
    setCursorLine(h.line);
    readRef.current?.querySelector(`[data-line="${h.line}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function copyAll() {
    navigator.clipboard?.writeText(system).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-1.5" data-testid="prompt-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex gap-0.5 rounded-lg bg-ink-800 p-0.5 text-[12px]">
          {(
            [
              ["edit", "编辑"],
              ["read", "阅读"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v} data-testid={`btn-prompt-${v}`} className={cx("px-2.5 py-0.5", view === v ? "rounded-md bg-ink-900 font-medium text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
              {l}
            </button>
          ))}
        </div>
        {view === "edit" && (
          <>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHit(-1);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go(e.shiftKey ? -1 : 1))}
              placeholder="搜索（Enter 下一个）"
              title="Enter 下一个，Shift+Enter 上一个"
              aria-label="搜索提示词"
              className="min-w-36 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] outline-none focus:border-ink-400"
            />
            {q && (
              <>
                <span className="text-[11.5px] text-ink-400" data-testid="search-count">
                  {matches.length ? `${hit >= 0 ? hit + 1 : 0}/${matches.length} 处${hit >= 0 ? ` · 第 ${lineOf(system, matches[hit])} 行` : ""}` : "没有匹配"}
                </span>
                <Btn onClick={() => go(-1)} disabled={!matches.length} aria-label="上一个匹配">
                  ↑
                </Btn>
                <Btn onClick={() => go(1)} disabled={!matches.length} aria-label="下一个匹配">
                  ↓
                </Btn>
              </>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Btn onClick={copyAll} title="复制提示词正文（System）全文" data-testid="btn-copy-prompt">
            {copied ? "已复制" : "复制全文"}
          </Btn>
          {outline.length > 0 && (
            <Btn onClick={() => setTocOpen((v) => !v)} aria-pressed={tocOpen}>
              {tocOpen ? "收起目录" : "目录"}
            </Btn>
          )}
        </span>
      </div>
      <div className={cx("grid gap-2", tocOpen && outline.length ? "grid-cols-[160px_1fr]" : "grid-cols-1")}>
        {tocOpen && outline.length > 0 && (
          <nav aria-label="规则目录" className="max-h-[55vh] overflow-auto rounded-lg border border-ink-700 bg-ink-900 py-1 text-[12px]">
            {outline.map((h) => (
              <button
                key={h.line}
                onClick={() => goHeading(h)}
                className={cx("block w-full truncate px-2.5 py-1 text-left hover:bg-ink-800", cursorLine >= h.line && !outline.some((x) => x.line > h.line && x.line <= cursorLine) && "bg-accent/[0.07] text-accent")}
                title={`第 ${h.line} 行 · ${h.title}`}
              >
                {h.title}
              </button>
            ))}
          </nav>
        )}
        {view === "edit" ? (
          <textarea
            ref={ref}
            value={system}
            onChange={(e) => onSystem(e.target.value)}
            onSelect={(e) => setCursorLine(lineOf(system, e.currentTarget.selectionStart))}
            aria-label="System 提示词"
            spellCheck={false}
            className="h-[55vh] w-full resize-y rounded-lg border border-ink-700 bg-ink-900 p-2.5 font-mono text-[12.5px] leading-6 outline-none focus:border-ink-400"
          />
        ) : (
          <div ref={readRef} className="prompt-md h-[55vh] overflow-auto rounded-lg border border-ink-700 bg-ink-900 px-4 py-3" data-testid="prompt-read">
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MD_COMPONENTS}>
              {markdown}
            </Markdown>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-400">
        <span data-testid="cursor-line">
          {view === "edit" ? `第 ${cursorLine} 行 / ` : ""}共 {totalLines} 行 · {system.length.toLocaleString()} 字
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
