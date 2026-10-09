import type { PromptKind } from "@/lib/contracts/run";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { FIELD_LABELS } from "@/lib/schemas/common";

// 从快照显式构造 P1~P4 请求（v3 外层：schema_version / prompt / request_id / context / input）。
// 构造是纯函数，只使用快照中的数据，不隐式拉取业务数据。

export const INPUT_BUILDER_VERSION = "1.0.0";

export type BuildResult =
  | { ok: true; request: Record<string, unknown>; builderId: string; warnings: string[]; requiresFiles: string[] }
  | { ok: false; code: string; message: string };

type Rec = Record<string, unknown>;
const PCODE: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4" };
const CN_TO_KEY: Record<string, string> = Object.fromEntries(Object.entries(FIELD_LABELS).map(([k, v]) => [v, k]));
/** Demo 用 "UNKNOWN" 作缺失占位；按 v3 契约转为空字符串（构造规则，已版本化） */
const val = (v: unknown) => (v === undefined || v === null || v === "UNKNOWN" ? "" : String(v));

function envelope(kind: PromptKind, snapshot: InputSnapshot, context: Rec, input: Rec) {
  return {
    schema_version: "jiuli-ai-v3",
    prompt: PCODE[kind],
    request_id: `STUDIO-${snapshot.snapshot_id}-${PCODE[kind]}`,
    context,
    input,
  };
}

function identityFromFields(fields: Record<string, string>) {
  const id: Record<string, string> = {};
  for (const [cn, v] of Object.entries(fields)) {
    const k = CN_TO_KEY[cn] ?? { 产地: "origin" }[cn];
    if (k && ["model", "brand", "origin", "quantity", "unit", "material_no", "purchase_order_no", "sku"].includes(k)) id[k] = val(v);
  }
  return id;
}

export function buildInput(kind: PromptKind, snapshot: InputSnapshot): BuildResult {
  const payload = snapshot.normalized_payload as Rec;

  // 1) 快照自带对应阶段的请求（录制样本 / 手动导入）：原样使用
  const requests = (payload.requests as Rec | undefined) ?? {};
  const recorded = (requests[kind] ?? (payload.request_kind === kind ? payload.request : undefined)) as Rec | undefined;
  if (recorded) return { ok: true, request: recorded, builderId: "passthrough-snapshot-request", warnings: [], requiresFiles: [] };

  if (kind === "GENERIC_JSON") {
    return { ok: true, request: payload, builderId: "generic-snapshot-payload", warnings: [], requiresFiles: [] };
  }

  if (snapshot.source_type !== "JIULI_READONLY") {
    return { ok: false, code: "NO_INPUT_FOR_KIND", message: `该快照没有可用于 ${PCODE[kind]} 的请求数据。请导入对应阶段的 request JSON，或从九立只读导入。` };
  }

  const customer = payload.customer as Rec;
  const task = payload.task as Rec | undefined;
  const lines = (payload.lines as Rec[]) ?? [];
  const insp = (payload.inspections as { batches: Rec[]; sourceLines: Rec[]; groups: Rec[] }) ?? { batches: [], sourceLines: [], groups: [] };
  const extracted = (payload.extracted as Rec) ?? {};
  const warnings: string[] = [];

  const fileContent = (fileId: string) => extracted[fileId];
  const missingText = (ids: string[]) => ids.filter((id) => fileContent(id) === undefined);

  switch (kind) {
    case "JIULI_P1": {
      if (!task) return { ok: false, code: "NO_TASK", message: "快照中没有委托任务，无法构造 P1 输入" };
      const mainId = String(task.fileId);
      const supporting = ((task.supportingFileIds as string[]) ?? []).map(String);
      if (supporting.length) warnings.push(`辅助材料 ${supporting.join(", ")} 的类型（发票/箱单）在 Demo 数据中未标明，未纳入请求`);
      const materials = [{ file_id: mainId, material_type: "ORDER", segments: [], content: fileContent(mainId) ?? null }];
      return {
        ok: true,
        builderId: "jiuli-demo-p1",
        warnings,
        requiresFiles: missingText([mainId]),
        request: envelope(kind, snapshot, { customer_directory: [{ customer_id: customer.customer_id, customer_name: customer.name, aliases: customer.aliases ?? [] }], normalization: {} }, { materials }),
      };
    }
    case "JIULI_P2": {
      const fileIds = [...new Set(insp.batches.map((b) => String(b.fileId)).filter(Boolean))];
      if (!fileIds.length) return { ok: false, code: "NO_INSPECTION", message: "快照中没有查货批次，无法构造 P2 输入" };
      return {
        ok: true,
        builderId: "jiuli-demo-p2",
        warnings,
        requiresFiles: missingText(fileIds),
        request: envelope(kind, snapshot, { customer_id: customer.customer_id, normalization: {} }, { files: fileIds.map((id) => ({ file_id: id, segments: [], content: fileContent(id) ?? null })) }),
      };
    }
    case "JIULI_P3": {
      if (!task || !lines.length) return { ok: false, code: "NO_TASK", message: "快照中没有委托行，无法构造 P3 输入" };
      if (!insp.sourceLines.length) return { ok: false, code: "NO_INSPECTION", message: "快照中没有查货原始行，无法构造 P3 输入" };
      const groupOf = new Map<string, string>();
      insp.groups.forEach((g) => ((g.sourceLineIds as string[]) ?? []).forEach((id) => groupOf.set(id, String(g.id))));
      const orderOf = new Map(insp.batches.map((b) => [String(b.id), b]));
      const order_rows = lines.map((l) => {
        const fields = (l.fields as Record<string, string>) ?? {};
        const src = (l.source as Rec) ?? {};
        return {
          order_row_id: String(l.id),
          customer_id: String(l.customerId),
          identity: identityFromFields(fields),
          evidence: Object.entries(identityFromFields(fields))
            .filter(([, v]) => v !== "")
            .map(([k, v]) => ({ evidence_key: `E-O-${String(l.id)}-${k}`, field: k, value: v, source: { file_id: src.fileId ?? "", page: src.page ?? null, sheet: src.sheet ?? null, row: src.row ?? null, column: null, raw_text: v } })),
        };
      });
      const inspection_candidates = insp.sourceLines.map((s) => {
        const fields = (s.fields as Record<string, string>) ?? {};
        const src = (s.source as Rec) ?? {};
        const ord = orderOf.get(String(s.inspectionOrderId));
        return {
          raw_row_id: String(s.id),
          customer_id: String(s.customerId),
          logical_inspection_id: String(s.inspectionOrderId),
          warehouse_no: val(ord?.warehouseNo),
          merged_product_id: groupOf.get(String(s.id)) ?? null,
          identity: identityFromFields(fields),
          // Studio 无法证明范围完整性，如实标为 UNCERTAIN
          scope_summary: { coverage: "UNCERTAIN", overlap: "UNKNOWN", has_extra_goods: false, has_unresolved_goods: false },
          evidence: Object.entries(identityFromFields(fields))
            .filter(([, v]) => v !== "")
            .map(([k, v]) => ({ evidence_key: `E-I-${String(s.id)}-${k}`, field: k, value: v, source: { file_id: src.fileId ?? "", page: src.page ?? null, sheet: null, row: null, column: null, raw_text: v } })),
          occupied_by_order_row_id: (s.occupation as string | null) ?? null,
        };
      });
      warnings.push("retrieval_complete=false：Studio 快照无法证明候选召回完整");
      return {
        ok: true,
        builderId: "jiuli-demo-p3",
        warnings,
        requiresFiles: [],
        request: envelope(kind, snapshot, { customer_id: customer.customer_id, retrieval_complete: false }, { order_rows, inspection_candidates, proposed_groups: [], comparison_results: [] }),
      };
    }
    case "JIULI_P4": {
      const relations = (payload.relations as Rec[]) ?? [];
      if (!relations.length) {
        return { ok: false, code: "NO_MATCHED_RELATION", message: "P4 只核验已确定的 MATCHED 关系；快照中没有关系数据。请使用含 P4 request 的样本，或在九立确定关系后重新导入。" };
      }
      return { ok: false, code: "UNSUPPORTED", message: "九立 Demo 关系数据结构尚未确认，未实现 P4 构造器（不做猜测）。" };
    }
  }
  return { ok: false, code: "UNKNOWN_KIND", message: `未知 Prompt 种类 ${kind}` };
}

/** 展开用户模板：只替换登记的变量 */
export function renderUserTemplate(template: string, request: unknown): string {
  return template.split("{{input_json}}").join(JSON.stringify(request, null, 2));
}
