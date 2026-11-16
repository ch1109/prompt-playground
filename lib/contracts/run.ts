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
  /** 思考上限（token）：思考写到这么多就停下、开始回答；不填 = 不限制。原样发给服务商（DashScope 的 thinking_budget） */
  thinking_budget?: number;
  [k: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

/** 输入覆盖清单中的单个文件（R-02） */
export interface ManifestFile {
  file_id: string;
  file_name: string | null;
  media_type: string | null;
  original_file_hash: string | null;
  availability: string | null;
  /** 在请求中的材料类型（ORDER / INVOICE / INSPECTION…） */
  roles: string[];
  preprocessor_version: string | null;
  text_sent: boolean;
  text_chars: number;
  text_pages: number[];
  sheets: { name: string; rows: number | null; columns: number | null; cells: number | null }[] | null;
  /** 原件总页数；未知为 null */
  total_pages: number | null;
  /** 实际发送的页图页码（图片文件为 [null]）；null = 未开启附带图片 */
  image_pages_sent: (number | null)[] | null;
  image_skipped_reason: string | null;
  /** 既没作为文本也没作为图片进入模型的页码；总页数未知为 null（input-manifest@1.1.0 起） */
  omitted_pages?: number[] | null;
}

/** 输入覆盖清单（R-02）：这次实际发出了哪些文件、页、Sheet、文本和图片 */
export interface InputManifest {
  version: string;
  input_builder: string;
  snapshot_id: string;
  snapshot_source_type: string;
  snapshot_hash: string;
  files: ManifestFile[];
  sent_text_chars: number;
  sent_image_count: number;
  /** 页图覆盖，如 "20/25"；未附带图片为 null */
  page_coverage: string | null;
  truncation_reason: string | null;
  visual_evidence: "SENT" | "PARTIAL" | "NOT_SENT" | "NOT_APPLICABLE";
  /** 原件转图失败的文件与原因（input-manifest@1.1.0 起） */
  conversion_failures?: { file_id: string; reason: string }[];
  /** 没有缺页、解析失败、能力不足时才为 true */
  complete: boolean;
  gaps: string[];
  notes: string[];
}

/** 分阶段耗时（毫秒）；没有该阶段为 null */
export interface RunTiming {
  preprocess_ms: number | null;
  inference_ms: number | null;
  parse_ms: number | null;
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
  /** 随请求附带的原件页面图片（只记元数据，不存图片本身）；null = 未开启 */
  attached_images?: { file_id: string; page: number | null; media_type: string; sha256: string }[] | null;
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
  /** 服务商返回的结束原因（如 stop / length）；length 表示达到 max_tokens 被截断 */
  finish_reason?: string | null;
  latency_ms?: number | null;
  estimated_cost?: { value: number; currency: string; basis: string } | null;
  error?: { code: string; message: string } | null;
  /** REPLAY / 重渲染时指向原始 Run */
  replay_of_run_id?: string | null;
  /** 重渲染时版本变化说明 */
  rerender_note?: string | null;
  /** 输入覆盖清单（v1.1 起的 MODEL_RUN 才有） */
  input_manifest?: InputManifest | null;
  timing?: RunTiming | null;
  /** 服务商返回的请求 ID，便于向服务商追查 */
  provider_request_id?: string | null;
  /** 运行时使用的 system 与 user 模板原文（展开前），用于原样重试 */
  prompt_source?: { system: string; user_template: string } | null;
  /** 重试时指向被重试的 Run */
  retry_of_run_id?: string | null;
  // —— v1.3 起的新 Run 才有；旧 Run 没有这些字段，读取时按「未采集」处理，不回填 ——
  /** 构造出的输入（运行时的副本，快照被删除后仍可查） */
  built_input?: unknown;
  /** 实际发给服务商的请求结构（脱敏：正文只记长度与 hash，图片只记原件引用，不含密钥） */
  request_actual?: Record<string, unknown> | null;
  /** 服务商响应元数据：请求 ID、回报的模型名、结束原因、原样 usage、思考内容长度 */
  response_meta?: Record<string, unknown> | null;
  /** 模型思考内容全文（2026-10-14 起保存；更早的运行没有，服务商不返回时为 null） */
  reasoning_content?: string | null;
  /** 材料外发记录（2026-11 起的模型运行才有；更早的运行没有，显示「未记录」）：发给了谁、发了什么、谁授权、确认记录的时间（试运行等没有确认记录时为 null） */
  egress?: { provider_host: string; kinds: ("text" | "image")[]; authorized_by: string; consent_at: string | null } | null;
  /** Adapter / 渲染阶段的诊断；Adapter 出错没有 view_model 时也保留 */
  adapter_diagnostics?: Diagnostic[];
  /** P3 / P4 的上游 Run；本系统的 P3/P4 输入取自快照，不由上游 Run 生成，故为空并在 upstream_note 说明 */
  upstream_run_ids?: string[];
  upstream_note?: string | null;
  /** 隔离实验中的运行（v1.3 M3）：属于哪个实验、是候选还是基线、哪个样本 */
  experiment_ref?: { experiment_id: string; candidate_id: string; role: "BASELINE" | "CANDIDATE"; sample_id: string } | null;
}
