"use client";
import { useMemo, useState } from "react";
import { generateLayout, saveLayout } from "@/lib/client/api";
import { withEgressConfirm } from "@/lib/client/egress-confirm";
import { applyLayout } from "@/lib/layouts/apply";
import { LAYOUT_KINDS, validateLayout, type Layout, type LayoutKind } from "@/lib/layouts/types";
import { escapeToken, getByPointer } from "@/lib/pipeline/json-pointer";
import { LayoutView } from "@/components/views/layout-view";
import { Btn, cx } from "@/components/ui";

const KIND_LABEL: Record<LayoutKind, string> = { table: "表格", cards: "卡片", checklist: "清单", report: "报告" };
const NONE = "__none__";
const selectCls = "rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12.5px] outline-none focus:border-ink-400";

interface PathOpt {
  path: string;
  example: string;
}

const isScalar = (v: unknown) => v === null || typeof v !== "object";
const short = (v: unknown) => {
  const t = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  return t.length > 20 ? t.slice(0, 20) + "…" : t;
};
const lastKey = (path: string) => (path === "" ? "内容" : (path.split("/").pop() ?? "").replace(/~1/g, "/").replace(/~0/g, "~") || "内容");

/** 收集 value 里的路径：标量一定收；includeContainers 时对象/数组本身也收（报告章节用） */
function collect(value: unknown, prefix: string, depth: number, includeContainers: boolean, out: PathOpt[] = []): PathOpt[] {
  if (isScalar(value)) {
    out.push({ path: prefix, example: short(value) });
  } else if (Array.isArray(value)) {
    if (includeContainers && prefix !== "") out.push({ path: prefix, example: short(value) });
  } else {
    if (includeContainers && prefix !== "") out.push({ path: prefix, example: short(value) });
    if (depth > 0) for (const [k, v] of Object.entries(value as Record<string, unknown>)) collect(v, prefix + "/" + escapeToken(k), depth - 1, includeContainers, out);
  }
  return out;
}

/** 样例里「列表」所在的路径：根是列表 → ""；否则找第一个非空列表字段（最多两层） */
function findItemsPath(sample: unknown): string | null {
  if (Array.isArray(sample)) return "";
  if (sample === null || typeof sample !== "object") return null;
  const entries = Object.entries(sample as Record<string, unknown>);
  for (const [k, v] of entries) if (Array.isArray(v) && v.length) return "/" + escapeToken(k);
  for (const [k, v] of entries) {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (Array.isArray(v2) && v2.length) return "/" + escapeToken(k) + "/" + escapeToken(k2);
  }
  return null;
}

function firstItem(sample: unknown, itemsPath: string): unknown {
  const r = getByPointer(sample, itemsPath);
  return r.found && Array.isArray(r.value) ? r.value[0] : undefined;
}

/** 按样例推导某种形态的初始版式 */
function derive(kind: LayoutKind, sample: unknown): Layout {
  if (kind === "report") {
    const top = sample !== null && typeof sample === "object" && !Array.isArray(sample) ? Object.keys(sample) : [];
    const sections = top.length ? top.slice(0, 50).map((k) => ({ title: k.slice(0, 40), path: "/" + escapeToken(k) })) : [{ title: "全部内容", path: "" }];
    return { version: 1, kind: "report", sections };
  }
  const itemsPath = findItemsPath(sample) ?? "";
  const item = firstItem(sample, itemsPath);
  const direct = item !== null && typeof item === "object" && !Array.isArray(item) ? collect(item, "", 1, false).filter((o) => o.path !== "") : [];
  const leaves = direct.length ? direct : collect(item, "", 3, false);
  const cols = (leaves.length ? leaves : [{ path: "", example: "" }]).slice(0, 8);
  const pick = (re: RegExp) => leaves.find((o) => re.test(lastKey(o.path)))?.path;
  const titlePath = (leaves.find((o) => /^(name|title|label|名称|标题|名字)$/i.test(lastKey(o.path))) ?? leaves.find((o) => /[^\d.\-\s]/.test(o.example)) ?? leaves[0])?.path ?? "";
  if (kind === "table") return { version: 1, kind, itemsPath, columns: cols.map((o) => ({ label: lastKey(o.path).slice(0, 40), path: o.path })) };
  if (kind === "cards") return { version: 1, kind, itemsPath, titlePath, fields: cols.filter((o) => o.path !== titlePath).map((o) => ({ label: lastKey(o.path).slice(0, 40), path: o.path })) };
  const l: Layout = { version: 1, kind: "checklist", itemsPath, titlePath };
  const status = pick(/status|state|result|pass|状态|结果/i);
  const severity = pick(/severity|level|严重|级别/i);
  const detail = pick(/detail|reason|desc|message|说明|详情|原因/i);
  if (status !== undefined) l.statusPath = status;
  if (severity !== undefined) l.severityPath = severity;
  if (detail !== undefined) l.detailPath = detail;
  return l;
}

type Row = { label: string; path: string };
const getRows = (l: Layout): Row[] | null => (l.kind === "table" ? l.columns : l.kind === "cards" ? l.fields : l.kind === "report" ? l.sections.map((s) => ({ label: s.title, path: s.path })) : null);
function setRows(l: Layout, rows: Row[]): Layout {
  if (l.kind === "table") return { ...l, columns: rows.map((r) => ({ ...l.columns.find((c) => c.path === r.path && c.label === r.label), ...r })) };
  if (l.kind === "cards") return { ...l, fields: rows };
  if (l.kind === "report") return { ...l, sections: rows.map((r) => ({ title: r.label, path: r.path })) };
  return l;
}

function PathSelect({ label, value, options, optional, onChange, testid }: { label: string; value: string | undefined; options: PathOpt[]; optional?: boolean; onChange: (v: string | undefined) => void; testid: string }) {
  const known = value === undefined || options.some((o) => o.path === value);
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className="w-14 shrink-0 text-ink-300">{label}</span>
      <select className={cx(selectCls, "min-w-0 flex-1")} value={value ?? ""} onChange={(e) => onChange(e.target.value === NONE ? undefined : e.target.value)} title={value ?? ""} data-testid={testid}>
        {optional && <option value={NONE}>不使用</option>}
        {!known && <option value={value}>{lastKey(value ?? "")}</option>}
        {options.map((o) => (
          <option key={o.path} value={o.path}>
            {lastKey(o.path)}（例：{o.example}）
          </option>
        ))}
      </select>
    </label>
  );
}

/** 调整版式弹窗：选形态、微调列/字段/章节、实时预览、保存。路径只放悬停提示 */
export function LayoutEditor({ projectId, promptId, runId, sample, initial, onClose, onSaved }: { projectId: string; promptId: string; runId: string; sample: unknown; initial: Layout | null; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<LayoutKind>(initial?.kind ?? (findItemsPath(sample) !== null ? "table" : "report"));
  const [drafts, setDrafts] = useState<Partial<Record<LayoutKind, Layout>>>(initial ? { [initial.kind]: initial } : {});
  const [busy, setBusy] = useState<"" | "gen" | "save">("");
  const [error, setError] = useState("");

  const layout = useMemo(() => drafts[kind] ?? derive(kind, sample), [drafts, kind, sample]);
  const update = (l: Layout) => setDrafts((d) => ({ ...d, [kind]: l }));
  const preview = useMemo(() => applyLayout(layout, sample), [layout, sample]);

  const itemsPath = layout.kind === "report" ? "" : layout.itemsPath;
  const itemOpts = useMemo(() => {
    const it = firstItem(sample, findItemsPath(sample) !== null && !Array.isArray(getByPointer(sample, itemsPath).value) ? findItemsPath(sample)! : itemsPath);
    return collect(it, "", 3, false);
  }, [sample, itemsPath]);
  const sectionOpts = useMemo(() => collect(sample, "", 2, true).filter((o) => o.path !== ""), [sample]);
  const addOpts = layout.kind === "report" ? sectionOpts : itemOpts;
  const rows = getRows(layout);

  const patchRows = (next: Row[]) => update(setRows(layout, next));
  const move = (i: number, d: -1 | 1) => {
    if (!rows) return;
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    patchRows(next);
  };

  async function generate() {
    setBusy("gen");
    setError("");
    try {
      const r = await withEgressConfirm(projectId, () => generateLayout(promptId, { run_id: runId, want: kind }));
      if (!r) return;
      const v = validateLayout(r.layout);
      if (!v.ok) return setError("AI 给出的版式不可用：" + v.errors.join("；"));
      setDrafts((d) => ({ ...d, [v.layout.kind]: v.layout }));
      setKind(v.layout.kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setError("");
    if (rows && !rows.length && layout.kind !== "cards") return setError(layout.kind === "table" ? "表格至少要有一列" : "报告至少要有一个章节");
    if (rows?.some((r) => !r.label.trim())) return setError("显示名不能为空");
    const v = validateLayout(layout);
    if (!v.ok) return setError(v.errors.join("；"));
    setBusy("save");
    try {
      await saveLayout(promptId, v.layout);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      setBusy("");
    }
  }

  const noun = layout.kind === "table" ? "列" : layout.kind === "cards" ? "字段" : "章节";

  return (
    <>
      <div className="fixed inset-0 z-50 bg-ink-100/25" onClick={() => !busy && onClose()} aria-hidden="true" />
      <div role="dialog" aria-label="调整版式" data-testid="layout-editor" className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100%-32px)] w-[960px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-[14px] font-semibold">调整版式</h2>
          <div className="flex gap-3 text-[12.5px]" role="radiogroup" aria-label="版式形态">
            {LAYOUT_KINDS.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-1">
                <input type="radio" name="layout-kind" checked={kind === k} onChange={() => setKind(k)} data-testid={`lk-${k}`} />
                {KIND_LABEL[k]}
              </label>
            ))}
          </div>
          <Btn tone="outline" onClick={generate} disabled={!!busy} className="ml-auto" data-testid="le-generate">
            {busy === "gen" ? "生成中…" : "让 AI 生成"}
          </Btn>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 overflow-auto md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <div className="space-y-2" data-testid="le-form">
            {layout.kind === "cards" && (
              <>
                <PathSelect label="标题" value={layout.titlePath} options={itemOpts} onChange={(v) => update({ ...layout, titlePath: v ?? "" })} testid="le-title" />
                <PathSelect label="角标" value={layout.badgePath} options={itemOpts} optional onChange={(v) => { const { badgePath: _b, ...rest } = layout; update(v === undefined ? rest : { ...rest, badgePath: v }); }} testid="le-badge" />
              </>
            )}
            {layout.kind === "checklist" && (
              <>
                {([["标题", "titlePath"], ["状态", "statusPath"], ["严重度", "severityPath"], ["说明", "detailPath"]] as const).map(([lab, key]) => (
                  <PathSelect
                    key={key}
                    label={lab}
                    value={layout[key]}
                    options={itemOpts}
                    optional={key !== "titlePath"}
                    onChange={(v) => {
                      const next = { ...layout, [key]: v } as Layout;
                      if (v === undefined) delete (next as unknown as Record<string, unknown>)[key];
                      update(next);
                    }}
                    testid={`le-${key}`}
                  />
                ))}
              </>
            )}
            {rows && (
              <>
                <ul className="space-y-1.5">
                  {rows.map((r, i) => (
                    <li key={i} className="flex items-center gap-1" data-testid="le-row">
                      <input value={r.label} maxLength={40} title={r.path === "" ? "整项内容" : r.path} aria-label={`${noun}${i + 1}的显示名`} onChange={(e) => patchRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={cx(selectCls, "min-w-0 flex-1")} />
                      <Btn onClick={() => move(i, -1)} disabled={i === 0} aria-label="上移" title="上移" className="px-2">
                        ↑
                      </Btn>
                      <Btn onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="下移" title="下移" className="px-2">
                        ↓
                      </Btn>
                      <Btn tone="danger" onClick={() => patchRows(rows.filter((_, j) => j !== i))} aria-label="删除" className="px-2">
                        删除
                      </Btn>
                    </li>
                  ))}
                </ul>
                <select
                  className={cx(selectCls, "w-full")}
                  value=""
                  aria-label={`添加一${layout.kind === "table" ? "列" : layout.kind === "cards" ? "个字段" : "个章节"}`}
                  data-testid="le-add"
                  onChange={(e) => {
                    const o = addOpts.find((x) => x.path === e.target.value);
                    if (o) patchRows([...rows, { label: lastKey(o.path).slice(0, 40), path: o.path }]);
                  }}
                >
                  <option value="">＋ 添加{layout.kind === "table" ? "一列" : layout.kind === "cards" ? "字段" : "章节"}…</option>
                  {addOpts.map((o) => (
                    <option key={o.path} value={o.path} title={o.path}>
                      {lastKey(o.path)}（例：{o.example}）
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div className="min-w-0 overflow-auto rounded-lg border border-ink-700 bg-ink-850 p-2" data-testid="le-preview">
            <LayoutView result={preview} />
          </div>
        </div>

        {error && (
          <p className="text-[12px] text-risk" data-testid="le-error">
            {error}
          </p>
        )}
        <div className="flex items-center gap-1.5">
          <Btn tone="primary" onClick={save} disabled={!!busy || preview.kind === "mismatch"} title={preview.kind === "mismatch" ? "版式没对上这次的输出，先调整或让 AI 生成" : undefined} data-testid="le-save">
            保存
          </Btn>
          <Btn onClick={onClose} disabled={!!busy}>
            取消
          </Btn>
        </div>
      </div>
    </>
  );
}
