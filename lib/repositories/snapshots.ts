import type { InputSnapshot, SnapshotMaterial, SnapshotSourceType } from "@/lib/contracts/snapshot";
import { newId, sha256, stableStringify } from "@/lib/hash";
import { db } from "./db";

export { INPUT_BUILDER_VERSION } from "@/lib/input-builders";
import { INPUT_BUILDER_VERSION } from "@/lib/input-builders";

export function createSnapshot(input: {
  project_id: string;
  source_type: SnapshotSourceType;
  label: string;
  source_ids?: InputSnapshot["source_ids"];
  source_version?: string | null;
  data_contract_version: string;
  materials?: SnapshotMaterial[];
  normalized_payload: Record<string, unknown>;
  warnings?: string[];
  parent_snapshot_id?: string | null;
}): InputSnapshot {
  const snap: InputSnapshot = {
    snapshot_id: newId("snap"),
    project_id: input.project_id,
    source_type: input.source_type,
    source_ids: input.source_ids ?? {},
    source_version: input.source_version ?? null,
    imported_at: new Date().toISOString(),
    content_hash: sha256(stableStringify({ payload: input.normalized_payload, materials: input.materials ?? [] })),
    data_contract_version: input.data_contract_version,
    raw_material_ids: (input.materials ?? []).map((m) => m.material_id),
    materials: input.materials ?? [],
    normalized_payload: input.normalized_payload,
    warnings: input.warnings ?? [],
    redaction_policy: "NONE_LOCAL_ONLY",
    snapshot_visibility: "PROJECT",
    input_builder_version: INPUT_BUILDER_VERSION,
    parent_snapshot_id: input.parent_snapshot_id ?? null,
    label: input.label,
  };
  const d = db();
  d.prepare("INSERT INTO input_snapshots (snapshot_id, project_id, source_type, label, content_hash, imported_at, parent_snapshot_id, body) VALUES (?,?,?,?,?,?,?,?)").run(
    snap.snapshot_id,
    snap.project_id,
    snap.source_type,
    snap.label,
    snap.content_hash,
    snap.imported_at,
    snap.parent_snapshot_id ?? null,
    JSON.stringify(snap),
  );
  for (const m of snap.materials) {
    d.prepare("INSERT INTO input_materials VALUES (?,?,?,?,?,?,?)").run(
      m.material_id,
      snap.snapshot_id,
      m.file_id,
      m.content_hash ?? null,
      m.media_type ?? null,
      m.authorized_file_ref ?? null,
      m.availability,
    );
  }
  return snap;
}

/** 已删除或已到期的快照不可再用（到期后内容在下次清理时移除） */
export function getSnapshot(id: string): InputSnapshot | undefined {
  const row = db()
    .prepare("SELECT body FROM input_snapshots WHERE snapshot_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .get(id, new Date().toISOString()) as { body: string } | undefined;
  return row ? (JSON.parse(row.body) as InputSnapshot) : undefined;
}

export function listSnapshots(projectId: string, limit = 50) {
  purgeExpiredSnapshots();
  return db()
    .prepare(
      "SELECT snapshot_id, source_type, label, content_hash, imported_at, parent_snapshot_id, expires_at FROM input_snapshots WHERE project_id = ? AND deleted_at IS NULL ORDER BY imported_at DESC LIMIT ?",
    )
    .all(projectId, limit) as Record<string, unknown>[];
}

/**
 * 删除快照内容与材料记录，只保留最小留痕（ID、来源、标签、Hash、时间），
 * 让引用它的历史 Run 能显示"快照已删除"；Run 与原始输出不受影响。
 */
export function deleteSnapshot(id: string): boolean {
  const d = db();
  const row = d.prepare("SELECT body FROM input_snapshots WHERE snapshot_id = ? AND deleted_at IS NULL").get(id) as { body: string } | undefined;
  if (!row) return false;
  const s = JSON.parse(row.body) as InputSnapshot;
  const tombstone = { snapshot_id: s.snapshot_id, project_id: s.project_id, source_type: s.source_type, label: s.label, content_hash: s.content_hash, imported_at: s.imported_at, deleted: true };
  d.prepare("DELETE FROM input_materials WHERE snapshot_id = ?").run(id);
  d.prepare("UPDATE input_snapshots SET body = ?, deleted_at = ? WHERE snapshot_id = ?").run(JSON.stringify(tombstone), new Date().toISOString(), id);
  return true;
}

export function snapshotDeletedAt(id: string): string | null {
  const row = db().prepare("SELECT deleted_at, expires_at FROM input_snapshots WHERE snapshot_id = ?").get(id) as { deleted_at: string | null; expires_at: string | null } | undefined;
  if (!row) return null;
  return row.deleted_at ?? (row.expires_at && row.expires_at <= new Date().toISOString() ? row.expires_at : null);
}

/** 设置到期时间（ISO）；null = 永不到期（默认） */
export function setSnapshotExpiry(id: string, expiresAt: string | null) {
  db().prepare("UPDATE input_snapshots SET expires_at = ? WHERE snapshot_id = ? AND deleted_at IS NULL").run(expiresAt, id);
}

/** 删除所有已到期的快照内容，返回被删除的 ID */
export function purgeExpiredSnapshots(): string[] {
  const ids = (
    db().prepare("SELECT snapshot_id FROM input_snapshots WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?").all(new Date().toISOString()) as { snapshot_id: string }[]
  ).map((r) => r.snapshot_id);
  for (const id of ids) deleteSnapshot(id);
  return ids;
}

export function getMaterial(materialId: string) {
  return db().prepare("SELECT * FROM input_materials WHERE material_id = ?").get(materialId) as
    | { material_id: string; snapshot_id: string; file_id: string; authorized_file_ref: string | null; availability: string; media_type: string | null }
    | undefined;
}
