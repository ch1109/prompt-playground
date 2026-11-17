import type { InputSnapshot } from "@/lib/contracts/snapshot";
import type { Run } from "@/lib/contracts/run";
import { isV15, matchedRows, p3Request, p4Request } from "@/lib/input-builders/jiuli-chain";
import { getRun, queryRuns } from "@/lib/repositories/runs";
import { createSnapshot, getSnapshot } from "@/lib/repositories/snapshots";
import { RunServiceError } from "./service";

/** 用上游运行结果生成 P3 / P4 输入（v15 格式）。生成的输入是普通快照，之后照常选用、运行 */

type Rec = Record<string, unknown>;

export interface DeriveOption {
  run_id: string;
  label: string;
  started_at: string;
  model_name: string | null;
  /** P1：委托行数；P2：查货合并商品数；P3：委托行数 */
  count: number;
  /** 只有 P3：「已匹配」的委托行数 */
  matched?: number;
}

/** 本项目里最近的、运行成功且输出是 v15 的模型运行（重新整理的记录与原运行输出相同，不重复列出） */
function recentV15(projectId: string, kind: string, key: "r" | "h"): Run[] {
  return queryRuns({ projectId, kind, status: "SUCCEEDED", limit: 60 })
    .items.filter((r) => r.mode === "MODEL_RUN")
    .map((r) => getRun(r.run_id)!)
    .filter((r) => isV15(r.parsed_json, key));
}

const option = (r: Run, count: number, matched?: number): DeriveOption => ({
  run_id: r.run_id,
  label: (r as Run & { label?: string }).label ?? "",
  started_at: r.started_at,
  model_name: r.model_name ?? null,
  count,
  ...(matched === undefined ? {} : { matched }),
});

const goods = (p2: Rec) => (p2.h as Rec[]).reduce((n, h) => n + (Array.isArray(h.r) ? h.r.length : 0), 0);

/** 这次 P3 运行用的输入是否由本功能生成（记录了来源 P1 / P2 运行），是则返回两次运行 */
function p3Sources(p3: Run): { p1: Run; p2: Run } | null {
  const ids = p3.input_snapshot_id ? getSnapshot(p3.input_snapshot_id)?.source_ids : undefined;
  const p1 = typeof ids?.p1_run_id === "string" ? getRun(ids.p1_run_id) : undefined;
  const p2 = typeof ids?.p2_run_id === "string" ? getRun(ids.p2_run_id) : undefined;
  return p1 && p2 && isV15(p1.parsed_json, "r") && isV15(p2.parsed_json, "h") ? { p1, p2 } : null;
}

export function deriveOptions(projectId: string, target: string): { p1?: DeriveOption[]; p2?: DeriveOption[]; p3?: DeriveOption[] } {
  if (target === "JIULI_P3") {
    return {
      p1: recentV15(projectId, "JIULI_P1", "r").map((r) => option(r, ((r.parsed_json as Rec).r as unknown[]).length)),
      p2: recentV15(projectId, "JIULI_P2", "h").map((r) => option(r, goods(r.parsed_json as Rec))),
    };
  }
  if (target === "JIULI_P4") {
    // P3 输出没有 v 字段的要求，只看 r[]；只列出输入由 P1+P2 生成的（这样才能找到 P1/P2 的完整事实）
    const p3 = queryRuns({ projectId, kind: "JIULI_P3", status: "SUCCEEDED", limit: 60 })
      .items.filter((r) => r.mode === "MODEL_RUN")
      .map((r) => getRun(r.run_id)!)
      .filter((r) => Array.isArray((r.parsed_json as Rec | undefined)?.r));
    return {
      p3: p3.flatMap((r) => {
        const src = p3Sources(r);
        return src ? [option(r, ((r.parsed_json as Rec).r as unknown[]).length, matchedRows(src.p1.parsed_json as Rec, r.parsed_json as Rec).length)] : [];
      }),
    };
  }
  throw new RunServiceError("BAD_TARGET", "只能生成 P3 或 P4 的输入");
}

function upstream(id: string | undefined, kind: string, key: "r" | "h", name: string): Run {
  const r = id ? getRun(id) : undefined;
  if (!r || r.prompt_kind !== kind) throw new RunServiceError("UPSTREAM_NOT_FOUND", `找不到选中的 ${name} 运行`, 404);
  if (!isV15(r.parsed_json, key)) throw new RunServiceError("UPSTREAM_NOT_V15", `选中的 ${name} 运行没有可用的 v15 输出，不能用来生成输入`);
  return r;
}

const runLabel = (r: Run) => (r as Run & { label?: string }).label || r.run_id;

export function deriveP3(projectId: string, p1RunId?: string, p2RunId?: string): InputSnapshot {
  const p1 = upstream(p1RunId, "JIULI_P1", "r", "P1");
  const p2 = upstream(p2RunId, "JIULI_P2", "h", "P2");
  return createSnapshot({
    project_id: projectId,
    source_type: "DERIVED",
    label: `P3 · ${runLabel(p1)} + ${runLabel(p2)}`,
    source_ids: { p1_run_id: p1.run_id, p2_run_id: p2.run_id },
    data_contract_version: "jiuli-v15",
    normalized_payload: { request_kind: "JIULI_P3", request: p3Request(p1.parsed_json as Rec, p2.parsed_json as Rec) },
  });
}

/** 每条「已匹配」的委托行生成一份 P4 输入，按委托行顺序返回 */
export function deriveP4(projectId: string, p3RunId?: string): InputSnapshot[] {
  const p3 = p3RunId ? getRun(p3RunId) : undefined;
  if (!p3 || p3.prompt_kind !== "JIULI_P3") throw new RunServiceError("UPSTREAM_NOT_FOUND", "找不到选中的 P3 运行", 404);
  const src = p3Sources(p3);
  if (!src) throw new RunServiceError("P3_INPUT_NOT_DERIVED", "这次 P3 用的输入不是在这里用 P1+P2 结果生成的，找不到对应的 P1、P2 结果，没法生成 P4 输入");
  const p1 = src.p1.parsed_json as Rec;
  const rows = matchedRows(p1, p3.parsed_json as Rec);
  if (!rows.length) throw new RunServiceError("NO_MATCHED_ROWS", "这次 P3 没有「已匹配」的委托行，没有可以核验的行");
  return rows.map(({ row, rel }) =>
    createSnapshot({
      project_id: projectId,
      source_type: "DERIVED",
      label: `P4 · 委托行 ${row.id} · ${runLabel(src.p1)}`,
      source_ids: { p3_run_id: p3.run_id, p1_run_id: src.p1.run_id, p2_run_id: src.p2.run_id, order_row_id: String(row.id) },
      data_contract_version: "jiuli-v15",
      normalized_payload: { request_kind: "JIULI_P4", request: p4Request(p1, src.p2.parsed_json as Rec, row, rel) },
    }),
  );
}
