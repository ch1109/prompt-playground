import type { Diagnostic, ViewModel } from "./view-model";

export type PromptKind = "JIULI_P1" | "JIULI_P2" | "JIULI_P3" | "JIULI_P4" | "GENERIC_JSON";

export const PROMPT_KINDS: PromptKind[] = ["JIULI_P1", "JIULI_P2", "JIULI_P3", "JIULI_P4", "GENERIC_JSON"];

export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "SUCCEEDED"
  | "MODEL_ERROR"
  | "PARSE_ERROR"
  | "SCHEMA_INVALID"
  | "ADAPTER_ERROR"
  | "CANCELLED";

export type RunMode = "RENDER_ONLY" | "MODEL_RUN" | "REPLAY";

export type ValidationStatus = "VALID" | "INVALID" | "UNKNOWN_SCHEMA" | "NOT_RUN";

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  /** 显式提取方式：RAW=原文就是 JSON；FENCED=从唯一 ```json 代码块中提取 */
  extraction?: "RAW" | "FENCED";
  diagnostics: Diagnostic[];
  /** 解析失败位置（字符偏移 / 行列，均从 1 开始） */
  errorPosition?: { offset: number; line: number; column: number };
}

export interface SchemaValidationError {
  jsonPointer: string;
  keyword: string;
  expected: string;
  actual: string;
  message: string;
}

export interface SchemaValidation {
  status: ValidationStatus;
  schemaId?: string;
  schemaVersion?: string;
  promptKind?: PromptKind;
  errors: SchemaValidationError[];
}

export interface PipelineResult {
  parse: ParseResult;
  validation: SchemaValidation;
  adapterId?: string;
  adapterVersion?: string;
  rendererId?: string;
  rendererConfigVersion?: string;
  viewModel?: ViewModel;
  /** 若 Schema 无效但仍局部渲染，标记为"非完整结果" */
  partial: boolean;
  status: RunStatus;
  diagnostics: Diagnostic[];
}

export interface ModelParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [k: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

/** PRD §2.2 Run 完整信息 */
export interface Run {
  run_id: string;
  project_id: string;
  prompt_id: string;
  prompt_kind: PromptKind;
  prompt_version_id?: string | null;
  is_unsaved_draft: boolean;
  input_snapshot_id?: string | null;
  mode: RunMode;
  model_provider?: string | null;
  model_name?: string | null;
  provider_adapter_version?: string | null;
  model_params?: ModelParams | null;
  actual_prompt_hash?: string | null;
  built_input_hash?: string | null;
  /** 实际发送的展开后提示词（system + user），密钥已脱敏 */
  actual_prompt?: { system: string; user: string } | null;
  schema_id?: string | null;
  schema_version?: string | null;
  adapter_id?: string | null;
  adapter_version?: string | null;
  renderer_config_version?: string | null;
  started_at: string;
  ended_at?: string | null;
  status: RunStatus;
  raw_response: string;
  raw_response_hash: string;
  parsed_json?: unknown;
  parse_diagnostics: Diagnostic[];
  schema_diagnostics: Diagnostic[];
  view_model?: ViewModel | null;
  token_usage?: TokenUsage | null;
  latency_ms?: number | null;
  estimated_cost?: { value: number; currency: string; basis: string } | null;
  error?: { code: string; message: string } | null;
  /** REPLAY / 重渲染时指向原始 Run */
  replay_of_run_id?: string | null;
  /** 重渲染时版本变化说明 */
  rerender_note?: string | null;
}
