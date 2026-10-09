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
}

export interface FixtureSummary {
  id: string;
  title: string;
  origin: "STRUCTURE_EXAMPLE" | "RECORDED_MODEL_OUTPUT" | "CONSTRUCTED";
  promptKind: PromptKind;
  group: string;
  covers?: string[];
  hasRequest: boolean;
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
}

export interface RunDetail {
  run: Run & { label?: string; input_builder_id?: string; input_builder_warnings?: string[] };
  renderer: RendererConfig | null;
  annotations: AnnotationDTO[];
  snapshot: { snapshot_id: string; label: string; source_type: string; content_hash: string; imported_at: string; warnings: string[]; source_ids: Record<string, unknown> } | null;
  request: unknown;
  /** 引用的快照已删除/到期的时间 */
  snapshot_deleted_at?: string | null;
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
}

export interface CapabilityDTO {
  status: "CONNECTED_DEMO_FILES" | "NOT_CONFIGURED" | "CONNECTOR_UNAVAILABLE";
  realApi: boolean;
  readOnly: true;
  source: string;
  message: string;
  canPreviewFiles: boolean;
}
