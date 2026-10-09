import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { sha256, stableStringify } from "@/lib/hash";
import { db } from "@/lib/repositories/db";
import { createSnapshot, getSnapshot } from "@/lib/repositories/snapshots";
import type { FixtureDetail } from "./catalog";

/** 为样本创建（或复用同内容的）FIXTURE 快照，让 Adapter 能拿到请求上下文 / Gold / 基准草稿 */
export function snapshotForFixture(projectId: string, f: FixtureDetail): InputSnapshot | undefined {
  if (!f.request && !f.gold && !f.baseDraft) return undefined;
  const payload: Record<string, unknown> = { request_kind: f.promptKind, request: f.request, gold: f.gold, baseDraft: f.baseDraft, fixture_id: f.id, fixture_origin: f.origin };
  const hash = sha256(stableStringify({ payload, materials: [] }));
  const existing = db().prepare("SELECT snapshot_id FROM input_snapshots WHERE content_hash = ? AND source_type = 'FIXTURE' LIMIT 1").get(hash) as { snapshot_id: string } | undefined;
  if (existing) return getSnapshot(existing.snapshot_id);
  return createSnapshot({
    project_id: projectId,
    source_type: "FIXTURE",
    label: `样本 · ${f.title}`,
    source_ids: { fixture_id: f.id },
    data_contract_version: f.promptKind === "GENERIC_JSON" ? "generic" : "fixture",
    normalized_payload: payload,
    warnings: f.origin === "RECORDED_MODEL_OUTPUT" ? ["录制样本：request/response 为真实录制，不是 Gold 标准答案"] : [],
  });
}
