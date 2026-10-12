import type { InputManifest, Run } from "@/lib/contracts/run";
import type { EvidenceView } from "@/lib/contracts/view-model";

// 运行证据的读取时推导（v1.3 §5）：只看 Run 里真实保存了什么，不回填、不重新生成。
// 纯函数，不依赖 node 模块；服务端接口与浏览器都可以用。

export type CaptureQuality = "COMPLETE" | "PARTIAL" | "NOT_APPLICABLE";

export interface NotCaptured {
  key: string;
  label: string;
  /** 缺了这一项，诊断时会受到什么限制 */
  limitation: string;
}

export interface CaptureReport {
  quality: CaptureQuality;
  not_captured: NotCaptured[];
  /** 不计入完整度、但需要说明的事项（费用、规则集等本系统没有的概念） */
  notes: string[];
}

const NO_RESPONSE = new Set(["MODEL_ERROR", "CANCELLED", "RUNNING"]);

/** 采集完整度：真实模型运行才评估；缺哪一项、缺了有什么限制逐条列出 */
export function captureQuality(run: Run): CaptureReport {
  const notes = ["费用：服务商不返回价格，Studio 不估算", "规则集版本：本系统没有独立的规则集，规则写在提示词里"];
  if (run.mode !== "MODEL_RUN") return { quality: "NOT_APPLICABLE", not_captured: [], notes: ["没有调用模型（仅渲染 / 回放），不存在请求与预处理证据"] };
  const gotResponse = !NO_RESPONSE.has(run.status);
  const checks: [boolean, NotCaptured][] = [
    [!!run.actual_prompt, { key: "actual_prompt", label: "实际发送的提示词文本", limitation: "无法确认当时发给模型的内容" }],
    [!!run.prompt_source, { key: "prompt_source", label: "提示词模板原文", limitation: "无法原样重试，也无法区分模板与展开后的内容" }],
    [!!run.request_actual, { key: "request_actual", label: "实际请求结构（脱敏）", limitation: "无法确认图片和参数是怎样发给服务商的" }],
    [!gotResponse || !!run.response_meta, { key: "response_meta", label: "服务商响应元数据", limitation: "不知道服务商实际用的模型、是否产生了思考内容" }],
    [run.built_input !== undefined, { key: "built_input", label: "构造输入副本", limitation: "快照被删除或到期后，无法还原当时的输入" }],
    [!!run.input_manifest, { key: "input_manifest", label: "输入覆盖清单", limitation: "不知道哪些文件、页、Sheet 进入了模型" }],
    [!run.input_manifest || run.input_manifest.version !== "input-manifest@1.0.0", { key: "omitted_pages", label: "未进入模型的页（清单 1.1）", limitation: "只能从总页数推算哪些页没发，转换失败没有结构化记录" }],
    [!!run.timing, { key: "timing", label: "分阶段耗时", limitation: "无法区分预处理、模型和解析各花了多久" }],
    [!gotResponse || run.adapter_diagnostics !== undefined, { key: "adapter_diagnostics", label: "Adapter 诊断", limitation: "Adapter 出错时无法定位原因" }],
  ];
  if (run.prompt_kind === "JIULI_P3" || run.prompt_kind === "JIULI_P4")
    checks.push([run.upstream_run_ids !== undefined, { key: "upstream_run_ids", label: "上游 Run 关联说明", limitation: "无法判断输入是否来自某次 P1/P2 运行" }]);
  const not_captured = checks.filter(([ok]) => !ok).map(([, n]) => n);
  return { quality: not_captured.length ? "PARTIAL" : "COMPLETE", not_captured, notes };
}

export interface DiagnosticState {
  code: "MODEL_RUN_SUCCESS" | "PARSE_FAILED" | "SCHEMA_INVALID" | "INPUT_INCOMPLETE" | "ADAPTER_ERROR" | "EVAL_NOT_AVAILABLE" | "SCHEMA_VERSION_MISMATCH";
  label: string;
  reason: string;
}

/**
 * §5.4 的数据与诊断状态（可同时有多个）。不改变 Run 的 status，只在读取时给出解释。
 * activeSchemaVersion：提示词登记的期望输出版本；hasGold：输入快照里有没有独立的标准答案。
 */
export function diagnosticStates(run: Run, ctx: { activeSchemaVersion?: string | null; hasGold: boolean }): { states: DiagnosticState[]; warnings: DiagnosticState[] } {
  const states: DiagnosticState[] = [];
  const warnings: DiagnosticState[] = [];
  if (NO_RESPONSE.has(run.status)) return { states, warnings };
  if (run.mode === "MODEL_RUN") states.push({ code: "MODEL_RUN_SUCCESS", label: "模型响应成功", reason: "模型返回了内容；是否符合契约、是否正确还要看下面几项" });
  if (run.status === "PARSE_ERROR") states.push({ code: "PARSE_FAILED", label: "解析失败", reason: "回答不是合法 JSON；原始响应已原样保存" });
  const schemaErrors = run.schema_diagnostics.filter((d) => d.level === "ERROR").length;
  if (run.status === "SCHEMA_INVALID") states.push({ code: "SCHEMA_INVALID", label: "结构不符", reason: `JSON 可以解析，但有 ${schemaErrors} 处不符合约定的结构` });
  else if (run.status === "SUCCEEDED" && !run.schema_id && run.prompt_kind !== "GENERIC_JSON")
    states.push({ code: "SCHEMA_INVALID", label: "结构未登记", reason: `输出的 schema_version（${run.schema_version ?? "没有声明"}）不是已登记的九立结构，没有按契约校验` });
  if (run.status === "ADAPTER_ERROR") states.push({ code: "ADAPTER_ERROR", label: "整理表格出错", reason: "从结构映射到业务表格时出错；这是 Adapter 的问题，不能据此认定模型输出错误" });
  if (run.input_manifest && !run.input_manifest.complete) states.push({ code: "INPUT_INCOMPLETE", label: "输入不完整", reason: run.input_manifest.gaps[0] ?? "原件没有完整进入模型" });
  if (!ctx.hasGold) states.push({ code: "EVAL_NOT_AVAILABLE", label: "未评测", reason: "没有标准答案，只能看差异，不计算准确率" });
  if (run.schema_version && ctx.activeSchemaVersion && run.schema_version !== ctx.activeSchemaVersion)
    warnings.push({ code: "SCHEMA_VERSION_MISMATCH", label: "结构版本与提示词不一致", reason: `提示词登记的输出版本是 ${ctx.activeSchemaVersion}，这次输出声明的是 ${run.schema_version}，已按输出声明的版本整理` });
  return { states, warnings };
}

export interface RunEvidence {
  capture: CaptureReport;
  states: DiagnosticState[];
  warnings: DiagnosticState[];
}

export interface FieldInputCoverage {
  refId: string;
  status: "TEXT_SENT" | "IMAGE_SENT" | "NOT_SENT" | "UNKNOWN";
  text: string;
}

/**
 * 字段级「实际输入」：这个字段的每条来源，对应的原件页 / Sheet 当时有没有进入模型。
 * 只根据 Run 的输入覆盖清单判断；没有清单（旧 Run、仅渲染）就如实说未记录，不推测。
 */
export function fieldInputCoverage(evidence: EvidenceView[], manifest: InputManifest | null | undefined, mode: string): FieldInputCoverage[] {
  return evidence.map((e) => {
    const where = [e.fileName ?? e.fileId, e.page != null ? `第 ${e.page} 页` : null, e.sheet ? `Sheet「${e.sheet}」` : null].filter(Boolean).join(" ");
    const out = (status: FieldInputCoverage["status"], text: string) => ({ refId: e.id, status, text: `${where || "来源"}：${text}` });
    if (!e.fileId) return out("UNKNOWN", "来源在请求数据里，不对应原件页");
    if (mode !== "MODEL_RUN") return out("UNKNOWN", "没有调用模型，没有实际输入记录");
    if (!manifest) return out("UNKNOWN", "未记录（这条 Run 没有输入覆盖清单）");
    const f = manifest.files.find((x) => x.file_id === e.fileId);
    if (!f) return out("NOT_SENT", "这个文件不在本次请求里，没有进入模型");
    if (e.page != null && f.image_pages_sent?.includes(e.page)) return out("IMAGE_SENT", "页图已发送给模型");
    if (e.page != null && f.text_pages.includes(e.page)) return out("TEXT_SENT", "这一页的文本已发送");
    if (e.page != null && f.omitted_pages?.includes(e.page)) return out("NOT_SENT", "这一页没有进入模型");
    if (f.image_pages_sent?.includes(null)) return out("IMAGE_SENT", "图片已发送给模型");
    if (f.text_sent) return out("TEXT_SENT", e.page != null ? "文件文本已发送，但记录里没有逐页信息" : "文件文本已发送");
    return out("NOT_SENT", "这个文件既没发文本也没发图片");
  });
}
