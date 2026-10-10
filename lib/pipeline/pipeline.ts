import { findAdapter } from "@/lib/adapters/registry";
import type { AdapterContext } from "@/lib/adapters/types";
import type { PipelineResult, PromptKind } from "@/lib/contracts/run";
import type { Diagnostic, ViewModel } from "@/lib/contracts/view-model";
import { findRendererConfig } from "@/lib/renderer-config/registry";
import { validateAgainstRegistry } from "@/lib/schemas/registry";
import { parseRawResponse } from "./parse";

export interface PipelineInput {
  raw: string;
  promptKind: PromptKind;
  context: AdapterContext;
}

/**
 * RawResponse → ParseResult → SchemaValidation → BusinessAdapter → ViewModel（PRD §3.1）
 * - 不修改 raw；任何阶段失败都保留前面各层结果与诊断。
 * - 不调用任何模型或网络。
 */
export function runPipeline({ raw, promptKind, context }: PipelineInput): PipelineResult {
  const parse = parseRawResponse(raw);
  const diagnostics: Diagnostic[] = [...parse.diagnostics];

  if (!parse.ok) {
    // 通用提示词允许纯文本回答：不是 JSON 也算成功，按文本显示；看起来像 JSON 却解析失败的仍报错
    if (promptKind === "GENERIC_JSON" && diagnostics.some((d) => d.code === "NOT_PURE_JSON")) {
      const text = diagnostics.map((d) => (d.code === "NOT_PURE_JSON" ? { ...d, level: "INFO" as const, code: "TEXT_ANSWER", message: "回答是文本（不是 JSON），按文本显示。" } : d));
      return { parse, validation: { status: "NOT_RUN", errors: [] }, partial: false, status: "SUCCEEDED", diagnostics: text };
    }
    return { parse, validation: { status: "NOT_RUN", errors: [] }, partial: false, status: "PARSE_ERROR", diagnostics };
  }

  const validation = validateAgainstRegistry(parse.value, promptKind);
  for (const e of validation.errors) {
    diagnostics.push({ phase: "SCHEMA", level: "ERROR", code: `SCHEMA_${e.keyword.toUpperCase()}`, message: `${e.expected}；实际：${e.actual}`, jsonPointer: e.jsonPointer });
  }

  if (validation.status === "UNKNOWN_SCHEMA") {
    diagnostics.push({
      phase: "SCHEMA",
      level: "WARNING",
      code: "UNKNOWN_SCHEMA",
      message:
        promptKind === "GENERIC_JSON"
          ? "通用提示词：按 JSON 树展示。"
          : `未登记 (${promptKind}, ${validation.schemaVersion ?? "无 schema_version"}) 的 Schema，不套用九立模板，仅展示 JSON 树。`,
    });
    return { parse, validation, partial: false, status: "SUCCEEDED", diagnostics };
  }

  const adapter = findAdapter(promptKind, validation.schemaVersion);
  const renderer = adapter ? findRendererConfig(adapter.rendererId) : undefined;
  if (!adapter || !renderer) {
    diagnostics.push({ phase: "ADAPTER", level: "ERROR", code: "ADAPTER_NOT_REGISTERED", message: `没有登记 ${promptKind}/${validation.schemaVersion} 的 Adapter 或渲染配置` });
    return { parse, validation, partial: false, status: "ADAPTER_ERROR", diagnostics };
  }

  const partial = validation.status === "INVALID";
  try {
    const out = adapter.adapt(parse.value, context);
    diagnostics.push(...out.diagnostics);
    if (partial) {
      diagnostics.push({ phase: "RENDER", level: "WARNING", code: "PARTIAL_RENDER", message: "Schema 校验未通过：以下为可安全理解部分的局部渲染，非完整结果。" });
    }
    const viewModel: ViewModel = {
      viewModelVersion: "1.0",
      runId: context.runId,
      rendererId: adapter.rendererId,
      tables: out.tables,
      issues: out.issues,
      relations: out.relations,
      changes: out.changes,
      evidence: out.evidence,
      diagnostics,
      metadata: out.metadata,
    };
    return {
      parse,
      validation,
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      rendererId: renderer.renderer_id,
      rendererConfigVersion: renderer.renderer_config_version,
      viewModel,
      partial,
      status: partial ? "SCHEMA_INVALID" : "SUCCEEDED",
      diagnostics,
    };
  } catch (e) {
    diagnostics.push({
      phase: "ADAPTER",
      level: "ERROR",
      code: "ADAPTER_EXCEPTION",
      message: `Adapter ${adapter.adapterId}@${adapter.adapterVersion} 抛出异常：${e instanceof Error ? e.message : String(e)}`,
    });
    return {
      parse,
      validation,
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      partial,
      status: "ADAPTER_ERROR",
      diagnostics,
    };
  }
}
