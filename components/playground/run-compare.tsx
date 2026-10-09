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

export function diffJson(a: unknown, b: unknown) {
  const fa = flatten(a);
  const fb = flatten(b);
  const rows: { pointer: string; kind: "ADDED" | "REMOVED" | "CHANGED"; a?: string; b?: string }[] = [];
  for (const [k, v] of fa) {
    if (!fb.has(k)) rows.push({ pointer: k, kind: "REMOVED", a: v });
    else if (fb.get(k) !== v) rows.push({ pointer: k, kind: "CHANGED", a: v, b: fb.get(k) });
  }
  for (const [k, v] of fb) if (!fa.has(k)) rows.push({ pointer: k, kind: "ADDED", b: v });
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
      <h4 className="mb-1 text-[12px] font-semibold text-ink-300">{title}</h4>
      {hunks === null ? (
        <p className="text-[12px] text-ink-400">至少一方没有记录实际发送的提示词（例如「仅渲染」的 Run），无法对比。</p>
      ) : hunks.length === 0 ? (
        <p className="text-[12px] text-verify">完全相同</p>
      ) : (
        <pre className="overflow-auto rounded border border-ink-700 bg-ink-950 p-2 text-[11.5px] leading-5" data-testid="prompt-diff">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" role="dialog" aria-label="对比两次运行">
      <div className="flex max-h-full w-full max-w-5xl flex-col rounded-md border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
          <span className="font-semibold">运行对比</span>
          <Badge>{ids[0]}</Badge>→<Badge>{ids[1]}</Badge>
          <span className="text-[11px] text-ink-400">A=左 / B=右；仅展示差异，不代表准确率</span>
          <Btn className="ml-auto" onClick={onClose}>
            关闭
          </Btn>
        </div>
        <div className="overflow-auto p-2">
          {cmp && (
            <>
              <table className="mb-3 w-full text-[12px]" data-testid="compare-metrics">
                <thead className="text-ink-400">
                  <tr>
                    <th className="w-36 py-0.5 text-left font-medium">指标</th>
                    <th className="py-0.5 text-left font-medium">A</th>
                    <th className="py-0.5 text-left font-medium">B</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.metrics.map((m) => (
                    <tr key={m.key} className={cx("border-b border-ink-800", m.differs && "bg-risk/[0.07]")}>
                      <td className="py-0.5 text-ink-400">{m.key}</td>
                      <td className="py-0.5 font-mono break-all">{m.a}</td>
                      <td className="py-0.5 font-mono break-all">{m.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Hunks title="System 提示词差异" hunks={cmp.system} />
              <Hunks title="User 消息差异（含构造输入）" hunks={cmp.user} />
              <h4 className="mb-1 text-[12px] font-semibold text-ink-300">输出 JSON 差异</h4>
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
                    <td className="w-20 py-0.5">
                      <Badge tone={r.kind === "ADDED" ? "ok" : r.kind === "REMOVED" ? "bad" : "warn"}>{r.kind}</Badge>
                    </td>
                    <td className="w-[38%] py-0.5 pr-2 break-all text-ink-300">{r.pointer}</td>
                    <td className={cx("py-0.5 pr-2 break-all", r.a !== undefined && "text-stamp")}>{r.a ?? ""}</td>
                    <td className={cx("py-0.5 break-all", r.b !== undefined && "text-verify")}>{r.b ?? ""}</td>
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
