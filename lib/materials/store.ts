import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { InputSnapshot, SnapshotMaterial } from "@/lib/contracts/snapshot";
import { newId } from "@/lib/hash";
import { db } from "@/lib/repositories/db";
import { createSnapshot } from "@/lib/repositories/snapshots";
import { materialsDir, uploadedPath } from "./dir";
import { preprocessFile } from "./preprocess";

export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 20;
/** P1 材料类型 + P2 查货文件 */
export const UPLOAD_MATERIAL_TYPES = ["ORDER", "INVOICE", "PACKING_LIST", "INSPECTION"] as const;
export type UploadMaterialType = (typeof UPLOAD_MATERIAL_TYPES)[number];

export class UploadError extends Error {}

/** 上传原件 → 预处理 → 存入私有目录 → 创建 FILE_IMPORT 快照（原件不修改，记录 Hash 与预处理版本） */
export async function createFileSnapshot(input: {
  projectId: string;
  label?: string;
  customerName?: string;
  files: { name: string; buffer: Buffer; materialType: UploadMaterialType }[];
}): Promise<InputSnapshot> {
  if (!input.files.length) throw new UploadError("请至少选择一个文件");
  if (input.files.length > MAX_FILES) throw new UploadError(`一次最多上传 ${MAX_FILES} 个文件`);
  mkdirSync(materialsDir(), { recursive: true });
  const materials: SnapshotMaterial[] = [];
  const meta: Record<string, unknown>[] = [];
  const extracted: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const f of input.files) {
    const name = basename(f.name);
    if (!UPLOAD_MATERIAL_TYPES.includes(f.materialType)) throw new UploadError(`文件「${name}」的材料类型无效`);
    if (f.buffer.length > MAX_FILE_BYTES) throw new UploadError(`文件「${name}」超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    let pre;
    try {
      pre = await preprocessFile(f.buffer, name);
    } catch (e) {
      throw new UploadError(e instanceof Error ? e.message : String(e));
    }
    const hash = createHash("sha256").update(f.buffer).digest("hex");
    const stored = `${hash}${pre.ext}`;
    const abs = join(materialsDir(), stored);
    if (!existsSync(abs)) writeFileSync(abs, f.buffer, { flag: "wx" });
    const fileId = `U-${hash.slice(0, 12)}`;
    materials.push({
      material_id: newId("mat"),
      file_id: fileId,
      file_name: name,
      media_type: pre.media_type,
      content_hash: hash,
      authorized_file_ref: `upload:${stored}`,
      has_text_content: pre.has_text,
      availability: "AVAILABLE",
    });
    meta.push({ file_id: fileId, file_name: name, material_type: f.materialType, media_type: pre.media_type, sha256: hash, segments: pre.segments, has_text: pre.has_text, preprocessor_version: pre.preprocessor_version });
    if (pre.has_text) extracted[fileId] = pre.content;
    warnings.push(...pre.warnings.map((w) => `${name}：${w}`));
  }
  return createSnapshot({
    project_id: input.projectId,
    source_type: "FILE_IMPORT",
    label: input.label?.trim() || `文件导入 · ${materials.map((m) => m.file_name).join("、")}`.slice(0, 120),
    source_ids: { file_names: materials.map((m) => m.file_name!) },
    data_contract_version: "file-import@1.0.0",
    materials,
    normalized_payload: { file_import: { customer_name: input.customerName?.trim() || null, materials: meta }, extracted },
    warnings,
  });
}

/** 已上传原件：只有被未删除快照引用时才可读取 */
export function resolveUploadedFile(fileId: string): { absolutePath: string; mediaType: string; fileName: string } | undefined {
  if (!/^U-[0-9a-f]{12}$/.test(fileId)) return undefined;
  const row = db()
    .prepare(
      "SELECT m.authorized_file_ref AS ref, m.media_type AS media_type, s.body AS body FROM input_materials m JOIN input_snapshots s ON s.snapshot_id = m.snapshot_id WHERE m.file_id = ? AND s.deleted_at IS NULL LIMIT 1",
    )
    .get(fileId) as { ref: string | null; media_type: string | null; body: string } | undefined;
  const abs = row?.ref ? uploadedPath(row.ref) : undefined;
  if (!row || !abs || !existsSync(abs)) return undefined;
  const name = (JSON.parse(row.body) as InputSnapshot).materials.find((m) => m.file_id === fileId)?.file_name ?? fileId;
  return { absolutePath: abs, mediaType: row.media_type ?? "application/octet-stream", fileName: name };
}
