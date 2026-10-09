"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import type { RunDetail } from "@/lib/client/types";
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

/** 手动并排对比两次历史 Run 的 JSON（轻量对比，不是带准确率的正式评测） */
export function RunCompare({ ids, onClose }: { ids: [string, string]; onClose: () => void }) {
  const [a, setA] = useState<RunDetail | null>(null);
  const [b, setB] = useState<RunDetail | null>(null);
  useEffect(() => {
    api<RunDetail>(`/api/runs/${ids[0]}`).then(setA);
    api<RunDetail>(`/api/runs/${ids[1]}`).then(setB);
  }, [ids]);
  const rows = useMemo(() => (a && b ? diffJson(a.run.parsed_json ?? a.run.raw_response, b.run.parsed_json ?? b.run.raw_response) : []), [a, b]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" role="dialog" aria-label="对比两次运行">
      <div className="flex max-h-full w-full max-w-5xl flex-col rounded-md border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
          <span className="font-semibold">JSON 对比</span>
          <Badge>{ids[0]}</Badge>→<Badge>{ids[1]}</Badge>
          <span className="text-[11px] text-ink-400">仅字段级差异，不代表准确率</span>
          <Btn className="ml-auto" onClick={onClose}>
            关闭
          </Btn>
        </div>
        <div className="overflow-auto p-2">
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
