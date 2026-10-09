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
  d.prepare("INSERT INTO input_snapshots VALUES (?,?,?,?,?,?,?,?)").run(
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

export function getSnapshot(id: string): InputSnapshot | undefined {
  const row = db().prepare("SELECT body FROM input_snapshots WHERE snapshot_id = ?").get(id) as { body: string } | undefined;
  return row ? (JSON.parse(row.body) as InputSnapshot) : undefined;
}

export function listSnapshots(projectId: string, limit = 50) {
  return (
    db()
      .prepare("SELECT snapshot_id, source_type, label, content_hash, imported_at, parent_snapshot_id FROM input_snapshots WHERE project_id = ? ORDER BY imported_at DESC LIMIT ?")
      .all(projectId, limit) as Record<string, unknown>[]
  );
}

export function getMaterial(materialId: string) {
  return db().prepare("SELECT * FROM input_materials WHERE material_id = ?").get(materialId) as
    | { material_id: string; snapshot_id: string; file_id: string; authorized_file_ref: string | null; availability: string; media_type: string | null }
    | undefined;
}
