"use client";
import { structuredPatch, type StructuredPatchHunk } from "diff";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import type { RunDetail } from "@/lib/client/types";
import type { Run } from "@/lib/contracts/run";
import { escapeToken } from "@/lib/pipeline/json-pointer";
import { Badge, Btn, cx } from "@/components/ui";

/** 把 JSON 展平为 pointer → 标量 */
export function flatten(v: unknown, p = "", out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(v)) {
    if (!v.length) out.set(p, "[]");
    v.forEach((x, i) => flatten(x, `${p}/${i}`, out));
  } else if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) out.set(p, "{}");
    for (const k of keys) flatten((v as Record<string, unknown>)[k], `${p}/${escapeToken(k)}`, out);
  } else out.set(p, JSON.stringify(v));
  return out;
}

type Obj = Record<string, unknown>;
type DiffRow = { pointer: string; kind: "ADDED" | "REMOVED" | "CHANGED"; a?: string; b?: string };

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * 对象数组的业务键（按优先级）：委托行 ID、v2 行引用、字段名、文件 ID、原文位置，最后才是模型自编的序号。
 * 原文位置 = 来源文件 + Sheet + 页 + 行，比模型序号可靠：少一行时后续行不会错位。
 */
const ROW_KEYS: [string, (o: Obj) => string | null][] = [
  ["order_row_id", (o) => str(o.order_row_id)],
  ["local_row_ref", (o) => str(o.local_row_ref)],
  ["local_raw_row_ref", (o) => str(o.local_raw_row_ref)],
  ["raw_row_id", (o) => str(o.raw_row_id)],
  ["field", (o) => str(o.field)],
  ["file_id", (o) => str(o.file_id)],
  [
    "原文位置",
    (o) => {
      const s = o.source as Obj | undefined;
      if (!s || typeof s !== "object" || (s.row == null && s.page == null)) return null;
      return [s.file_id, s.sheet, s.page, s.row].map((x) => (x == null || x === "" ? "-" : String(x))).join(":");
    },
  ],
  ["record_no", (o) => str(o.record_no)],
  ["row_no", (o) => str(o.row_no)],
];

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** 两边都能为每个元素给出非空且不重复的键，才用它对齐 */
function pickKey(a: unknown[], b: unknown[]) {
  if (!a.length || !b.length || !a.every(isObj) || !b.every(isObj)) return null;
  for (const [name, fn] of ROW_KEYS) {
    const ka = (a as Obj[]).map(fn);
    const kb = (b as Obj[]).map(fn);
    const ok = (ks: (string | null)[]) => ks.every((k) => k !== null) && new Set(ks).size === ks.length;
    if (ok(ka) && ok(kb)) return { name, ka: ka as string[], kb: kb as string[] };
  }
  return null;
}

function diffValue(a: unknown, b: unknown, p: string, rows: DiffRow[]) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = pickKey(a, b);
    if (key) {
      const seg = (k: string) => `${p}/[${key.name}=${k}]`;
      const ib = new Map(key.kb.map((k, i) => [k, i]));
      key.ka.forEach((k, i) => (ib.has(k) ? diffValue(a[i], b[ib.get(k)!], seg(k), rows) : leaves(a[i], seg(k), "REMOVED", rows)));
      const ia = new Set(key.ka);
      key.kb.forEach((k, i) => !ia.has(k) && leaves(b[i], seg(k), "ADDED", rows));
      return;
    }
    if (!a.length || !b.length) {
      if (a.length !== b.length) rows.push({ pointer: p, kind: "CHANGED", a: a.length ? `[${a.length} 项]` : "[]", b: b.length ? `[${b.length} 项]` : "[]" });
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= b.length) leaves(a[i], `${p}/${i}`, "REMOVED", rows);
      else if (i >= a.length) leaves(b[i], `${p}/${i}`, "ADDED", rows);
      else diffValue(a[i], b[i], `${p}/${i}`, rows);
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (k in b) diffValue(a[k], b[k], `${p}/${escapeToken(k)}`, rows);
      else leaves(a[k], `${p}/${escapeToken(k)}`, "REMOVED", rows);
    }
    for (const k of Object.keys(b)) if (!(k in a)) leaves(b[k], `${p}/${escapeToken(k)}`, "ADDED", rows);
    return;
  }
  // 标量或类型不同：作为整体比较（容器按展平后的文本比较）
  const fa = JSON.stringify(a);
  const fb = JSON.stringify(b);
  if (fa !== fb) {
    if (isObj(a) || Array.isArray(a) || isObj(b) || Array.isArray(b)) {
      leaves(a, p, "REMOVED", rows);
      leaves(b, p, "ADDED", rows);
    } else rows.push({ pointer: p, kind: "CHANGED", a: fa, b: fb });
  }
}

function leaves(v: unknown, p: string, kind: "ADDED" | "REMOVED", rows: DiffRow[]) {
  for (const [k, val] of flatten(v, p)) rows.push(kind === "ADDED" ? { pointer: k, kind, b: val } : { pointer: k, kind, a: val });
}

/** 两次输出的差异：对象数组按业务键对齐（见 ROW_KEYS），找不到可靠键时按位置；路径中的 [键=值] 表示按业务键定位 */
export function diffJson(a: unknown, b: unknown): DiffRow[] {
  const rows: DiffRow[] = [];
  diffValue(a, b, "", rows);
  return rows.sort((x, y) => x.pointer.localeCompare(y.pointer));
}

const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** 两段文本的逐行差异（前后各保留 2 行上下文）；任一方没有文本时为 null */
function textHunks(a?: string, b?: string): StructuredPatchHunk[] | null {
  if (a === undefined || b === undefined) return null;
  return structuredPatch("A", "B", a, b, "", "", { context: 2 }).hunks;
}

/** 两次 Run 的关键指标与实际发送提示词的差异（仅对比，不代表准确率） */
/** 版本显示：优先版本名称，其次 ID；运行时为未保存草稿的另行标注 */
function versionText(r: Run, label?: string | null) {
  if (!r.prompt_version_id) return r.mode === "MODEL_RUN" ? "未保存草稿" : "—";
  const name = label || r.prompt_version_id;
  return r.is_unsaved_draft ? `${name}（基于此版本的未保存草稿）` : name;
}

export function compareRuns(a: Run, b: Run, versionLabels: [string | null | undefined, string | null | undefined] = [undefined, undefined]) {
  const schemaErrors = (r: Run) => String(r.schema_diagnostics.filter((d) => d.level === "ERROR").length);
  const rows: [string, (r: Run) => string][] = [
    ["状态", (r) => r.status],
    ["模式", (r) => r.mode],
    ["模型", (r) => dash(r.model_name)],
    ["Prompt 版本", (r) => versionText(r, versionLabels[r === a ? 0 : 1])],
    ["实际提示词 Hash", (r) => dash(r.actual_prompt_hash?.slice(0, 12))],
    ["构造输入 Hash", (r) => dash(r.built_input_hash?.slice(0, 12))],
    ["输入快照", (r) => dash(r.input_snapshot_id)],
    ["模型参数", (r) => (r.model_params ? JSON.stringify(r.model_params) : "—")],
    ["输入 Token", (r) => dash(r.token_usage?.prompt_tokens)],
    ["输出 Token", (r) => dash(r.token_usage?.completion_tokens)],
    ["耗时 (ms)", (r) => dash(r.latency_ms)],
    ["结束原因", (r) => dash(r.finish_reason)],
    ["Schema 错误数", schemaErrors],
    ["原始响应 Hash", (r) => dash(r.raw_response_hash?.slice(0, 12))],
  ];
  return {
    metrics: rows.map(([key, f]) => ({ key, a: f(a), b: f(b), differs: f(a) !== f(b) })),
    system: textHunks(a.actual_prompt?.system, b.actual_prompt?.system),
    user: textHunks(a.actual_prompt?.user, b.actual_prompt?.user),
  };
}

function Hunks({ title, hunks }: { title: string; hunks: StructuredPatchHunk[] | null }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-100">{title}</h4>
      {hunks === null ? (
        <p className="text-[12px] text-ink-400">至少一方没有记录实际发送的提示词（例如「仅渲染」的 Run），无法对比。</p>
      ) : hunks.length === 0 ? (
        <p className="text-[12px] text-verify">完全相同</p>
      ) : (
        <pre className="overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-2 text-[11.5px] leading-5" data-testid="prompt-diff">
          {hunks.map((h, i) => (
            <div key={i}>
              <div className="text-info">{`@@ A 第 ${h.oldStart} 行 / B 第 ${h.newStart} 行 @@`}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={cx("whitespace-pre-wrap break-all", l[0] === "+" && "bg-verify/10 text-verify", l[0] === "-" && "bg-stamp/10 text-stamp", l[0] === " " && "text-ink-400")}>
                  {l}
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** 手动并排对比两次历史 Run 的 JSON（轻量对比，不是带准确率的正式评测） */
export function RunCompare({ ids, onClose }: { ids: [string, string]; onClose: () => void }) {
  const [a, setA] = useState<RunDetail | null>(null);
  const [b, setB] = useState<RunDetail | null>(null);
  useEffect(() => {
    api<RunDetail>(`/api/runs/${ids[0]}`).then(setA);
    api<RunDetail>(`/api/runs/${ids[1]}`).then(setB);
  }, [ids]);
  const rows = useMemo(() => (a && b ? diffJson(a.run.parsed_json ?? a.run.raw_response, b.run.parsed_json ?? b.run.raw_response) : []), [a, b]);
  const cmp = useMemo(() => (a && b ? compareRuns(a.run, b.run, [a.prompt_version_label, b.prompt_version_label]) : null), [a, b]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-100/25 p-8 backdrop-blur-[2px]" role="dialog" aria-label="对比两次运行">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <span className="font-semibold">运行对比</span>
          <Badge>{ids[0]}</Badge>→<Badge>{ids[1]}</Badge>
          <span className="text-[11px] text-ink-400">A=左 / B=右；仅展示差异，不代表准确率</span>
          <Btn className="ml-auto" onClick={onClose}>
            关闭
          </Btn>
        </div>
        <div className="overflow-auto px-5 py-4">
          {cmp && (
            <>
              <table className="mb-5 w-full text-[12px]" data-testid="compare-metrics">
                <thead className="text-ink-400">
                  <tr>
                    <th className="w-36 px-2 py-1 text-left font-medium">指标</th>
                    <th className="px-2 py-1 text-left font-medium">A</th>
                    <th className="px-2 py-1 text-left font-medium">B</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.metrics.map((m) => (
                    <tr key={m.key} className={cx("border-b border-ink-800", m.differs && "bg-risk/[0.07]")}>
                      <td className="px-2 py-1 text-ink-400">{m.key}</td>
                      <td className="px-2 py-1 font-mono break-all">{m.a}</td>
                      <td className="px-2 py-1 font-mono break-all">{m.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Hunks title="System 提示词差异" hunks={cmp.system} />
              <Hunks title="User 消息差异（含构造输入）" hunks={cmp.user} />
              <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-100">输出 JSON 差异</h4>
              <p className="mb-1 text-[11px] text-ink-400">行按业务键对齐（委托行 ID、字段名、原文位置等，路径中显示为 [键=值]），找不到可靠的键时才按位置比较。</p>
            </>
          )}
          {!a || !b ? (
            <p className="text-ink-400">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="text-verify">两次输出完全一致</p>
          ) : (
            <table className="w-full font-mono text-[11.5px]">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pointer + r.kind} className="border-b border-ink-800">
                    <td className="w-20 py-1">
                      <Badge tone={r.kind === "ADDED" ? "ok" : r.kind === "REMOVED" ? "bad" : "warn"}>{r.kind}</Badge>
                    </td>
                    <td className="w-[38%] py-1 pr-3 break-all text-ink-300">{r.pointer}</td>
                    <td className={cx("py-1 pr-3 break-all", r.a !== undefined && "text-stamp")}>{r.a ?? ""}</td>
                    <td className={cx("py-1 break-all", r.b !== undefined && "text-verify")}>{r.b ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
