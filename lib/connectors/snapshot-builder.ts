import type { SnapshotMaterial } from "@/lib/contracts/snapshot";
import { newId } from "@/lib/hash";
import { createSnapshot } from "@/lib/repositories/snapshots";
import { FIELD_LABELS, P1_VALUE_KEYS } from "@/lib/schemas/common";
import type { JiuliReadonlyConnector } from "./types";

const CN_TO_KEY: Record<string, string> = Object.fromEntries(Object.entries(FIELD_LABELS).map(([k, v]) => [v, k]));

/**
 * 从九立只读连接创建 Studio 隔离快照：
 * 读取 → 校验授权 → 保存到 Studio 自有存储。运行时不会再隐式拉取新数据；刷新只能创建新快照。
 */
export async function buildJiuliSnapshot(
  connector: JiuliReadonlyConnector,
  sel: { projectId: string; customerId: string; taskId?: string; batchIds: string[]; parentSnapshotId?: string | null },
) {
  const warnings: string[] = [];
  const customers = await connector.searchCustomers(sel.customerId, 1);
  const customer = customers.items.find((c) => c.customer_id === sel.customerId);
  if (!customer) throw new Error("客户不存在或无权访问");

  let task: Record<string, unknown> | undefined;
  let lines: Record<string, unknown>[] = [];
  if (sel.taskId) {
    const facts = await connector.getTaskFacts(sel.taskId);
    if (facts.task.customerId !== sel.customerId) throw new Error("任务不属于所选客户");
    task = facts.task;
    lines = facts.lines;
  }
  const insp = sel.batchIds.length ? await connector.getInspectionFacts(sel.customerId, sel.batchIds) : { batches: [], sourceLines: [], groups: [] };
  const relations = sel.taskId ? (await connector.getRelations(sel.taskId)).relations : [];

  const fileIds = [
    ...(task?.fileId ? [String(task.fileId)] : []),
    ...((task?.supportingFileIds as string[]) ?? []),
    ...insp.batches.map((b) => String(b.fileId)).filter(Boolean),
  ];
  const uniqueFileIds = [...new Set(fileIds)];
  const meta = uniqueFileIds.length ? await connector.getMaterialMetadata(uniqueFileIds) : [];
  const extracted: Record<string, unknown> = {};
  const materials: SnapshotMaterial[] = [];
  for (const m of meta) {
    if (!m.authorized) warnings.push(`文件 ${m.file_id} 无访问授权，只保存元数据`);
    else if (!m.exists) warnings.push(`文件 ${m.file_id} 原文件不存在或已失效`);
    if (!m.has_text_content) warnings.push(`文件 ${m.file_id} 没有预处理文本，不能发送给仅支持文本的模型`);
    if (m.authorized && m.has_text_content && connector.getExtractedContent) extracted[m.file_id] = await connector.getExtractedContent(m.file_id);
    materials.push({
      material_id: newId("mat"),
      file_id: m.file_id,
      file_name: m.file_name,
      media_type: m.media_type,
      content_hash: m.sha256,
      authorized_file_ref: m.authorized ? m.file_id : null,
      has_text_content: m.has_text_content && m.authorized,
      availability: !m.authorized ? "FORBIDDEN" : m.exists ? "AVAILABLE" : "MISSING",
    });
  }
  if (!relations.length && sel.taskId) warnings.push("九立 Demo 中该任务没有已确定的商品关系（match-relations 为空），P4 无法构造输入");

  // 完整基准草稿（供 P4 只读 Patch 模拟）：Demo 用中文字段名，"UNKNOWN" 是 Demo 的缺失占位，按空值处理
  const baseDraft = task
    ? {
        version: task.version ?? 0,
        rows: Object.fromEntries(
          lines.map((l) => {
            const fields = (l.fields as Record<string, string>) ?? {};
            const row: Record<string, string> = Object.fromEntries(P1_VALUE_KEYS.map((k) => [k, ""]));
            for (const [cn, v] of Object.entries(fields)) {
              const k = CN_TO_KEY[cn];
              if (k) row[k] = v === "UNKNOWN" ? "" : String(v);
            }
            return [String(l.id), row];
          }),
        ),
      }
    : undefined;

  return createSnapshot({
    project_id: sel.projectId,
    source_type: "JIULI_READONLY",
    label: `九立只读 · ${customer.name}${sel.taskId ? " · " + sel.taskId : ""}${sel.batchIds.length ? ` · ${sel.batchIds.length} 个查货批次` : ""}`,
    source_ids: { customer_id: sel.customerId, ...(sel.taskId ? { task_id: sel.taskId } : {}), batch_ids: sel.batchIds },
    source_version: task ? `draft.version=${String(task.version ?? "unknown")}` : null,
    data_contract_version: "jiuli-demo-mock@local",
    materials,
    normalized_payload: { customer, task, lines, inspections: insp, relations, extracted, baseDraft },
    warnings,
    parent_snapshot_id: sel.parentSnapshotId ?? null,
  });
}
