export type SnapshotSourceType = "FILE_IMPORT" | "JSON_IMPORT" | "JIULI_READONLY" | "FIXTURE";

export interface SnapshotMaterial {
  material_id: string;
  file_id: string;
  file_name?: string;
  media_type?: string;
  content_hash?: string;
  /** 只读授权文件引用（例如九立 Demo 内相对路径），绝不是任意文件系统路径 */
  authorized_file_ref?: string | null;
  /** 是否带有可直接发送给模型的文本化内容（预处理结果） */
  has_text_content: boolean;
  availability: "AVAILABLE" | "METADATA_ONLY" | "FORBIDDEN" | "MISSING";
}

/** PRD §1.2 InputSnapshot */
export interface InputSnapshot {
  snapshot_id: string;
  project_id: string;
  source_type: SnapshotSourceType;
  source_ids: Record<string, string | string[]>;
  source_version?: string | null;
  imported_at: string;
  content_hash: string;
  data_contract_version: string;
  raw_material_ids: string[];
  materials: SnapshotMaterial[];
  /** 导入时取得的只读事实；对 v3 录制样本，即 P1~P4 的 request JSON */
  normalized_payload: Record<string, unknown>;
  warnings: string[];
  redaction_policy: string;
  snapshot_visibility: "PRIVATE" | "PROJECT";
  input_builder_version: string;
  /** 刷新得到的新快照指向旧快照 */
  parent_snapshot_id?: string | null;
  label: string;
}
