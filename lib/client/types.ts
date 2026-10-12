import type { RendererConfig } from "@/lib/contracts/renderer-config";
import type { PromptKind, Run } from "@/lib/contracts/run";

export interface PromptDef {
  prompt_id: string;
  project_id: string;
  prompt_kind: PromptKind;
  name: string;
  active_schema_version: string | null;
}

export interface PromptVersionDTO {
  version_id: string;
  prompt_id: string;
  label: string;
  system_prompt: string;
  user_prompt_template: string;
  content_hash: string;
  created_at: string;
  source: string | null;
  parent_version_id?: string | null;
  change_note?: string | null;
  /** 是否为正式版本（v1.3 M3）；新保存的版本为 false */
  is_stable?: boolean;
}

export interface FixtureSummary {
  id: string;
  title: string;
  origin: "STRUCTURE_EXAMPLE" | "RECORDED_MODEL_OUTPUT" | "CONSTRUCTED";
  promptKind: PromptKind;
  group: string;
  covers?: string[];
  hasRequest: boolean;
  hasGold: boolean;
  schemaVersion: string | null;
  tags: string[];
  detail: { materials: { file_id: string; type: string | null; segments: string[] }[]; provenance: string | null; upstream: string | null; runnable: boolean };
  /** 本项目里的运行统计；样本没有输入快照、无法关联运行时为 null */
  stats?: { run_count: number; last_run_at: string | null; wrong_count: number } | null;
}

export interface AnnotationDTO {
  annotation_id: string;
  run_id: string;
  target_json_pointer: string | null;
  target: string | null;
  issue_type: string;
  expected_value: string | null;
  note: string | null;
  created_at: string;
  updated_at?: string | null;
  assessment?: "WRONG" | "CORRECT" | "UNSURE" | null;
  error_category?: string | null;
  category_confirmed?: boolean | null;
  model_value?: string | null;
  source_ref_ids?: string[];
  author?: string | null;
  /** 当前修订号与全部修订（旧到新） */
  revision?: number;
  revisions?: { revision: number; action: "CREATE" | "UPDATE" | "DELETE"; body: Omit<AnnotationDTO, "revision" | "revisions">; author: string | null; created_at: string }[];
}

export interface RunDetail {
  run: Run & { label?: string; input_builder_id?: string; input_builder_warnings?: string[] };
  renderer: RendererConfig | null;
  annotations: AnnotationDTO[];
  snapshot: { snapshot_id: string; label: string; source_type: string; content_hash: string; imported_at: string; warnings: string[]; source_ids: Record<string, unknown> } | null;
  request: unknown;
  /** 引用的快照已删除/到期的时间 */
  snapshot_deleted_at?: string | null;
  /** 运行时所用 Prompt 版本的名称 */
  prompt_version_label?: string | null;
  /** 采集完整度与诊断状态（读取时推导） */
  evidence?: import("@/lib/runs/run-evidence").RunEvidence;
}

export interface RunListItem {
  run_id: string;
  prompt_id: string;
  prompt_kind: string;
  mode: string;
  status: string;
  started_at: string;
  input_snapshot_id: string | null;
  label: string;
  model_name: string | null;
  is_unsaved_draft: boolean;
  replay_of_run_id: string | null;
  schema_id: string | null;
}

export interface SnapshotListItem {
  snapshot_id: string;
  source_type: string;
  label: string;
  content_hash: string;
  imported_at: string;
  parent_snapshot_id: string | null;
  /** 能构造出输入的 Prompt 种类 */
  usable_kinds: string[];
  /** 到期时间；null = 永不到期 */
  expires_at: string | null;
  source_ids: { customer_id?: string; task_id?: string; batch_ids?: string[]; fixture_id?: string; excluded_file_ids?: string[] };
}

export interface ProviderInfoDTO {
  provider: string;
  model: string;
  configured: boolean;
  supportsFileInput: boolean;
  adapterVersion: string;
  capabilities: import("@/lib/models/provider-adapter").ProviderCapabilities;
}

export interface CapabilityDTO {
  status: "CONNECTED_DEMO_FILES" | "NOT_CONFIGURED" | "CONNECTOR_UNAVAILABLE";
  realApi: boolean;
  readOnly: true;
  source: string;
  message: string;
  canPreviewFiles: boolean;
}
