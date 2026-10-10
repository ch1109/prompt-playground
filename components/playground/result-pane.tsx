"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import type { AnnotationDTO, RunDetail } from "@/lib/client/types";
import type { ViewModel } from "@/lib/contracts/view-model";
import { explainModelError } from "@/lib/models/error-hints";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { useStudio, type ResultTab } from "@/lib/state/studio-store";
import { EvidenceViewer } from "@/components/renderers/evidence-viewer";
import { BusinessView } from "@/components/views/business-view";
import { Badge, Btn, cx, Empty, runStatusView } from "@/components/ui";
import { JsonTree, RawText } from "./json-tree";
import { InputCoverage } from "./input-coverage";

const TABS: { id: ResultTab; label: string }[] = [
  { id: "visual", label: "可视化" },
  { id: "json", label: "原始 JSON" },
  { id: "schema", label: "结构校验" },
  { id: "meta", label: "运行信息" },
];

function cellIndex(vm?: ViewModel | null) {
  const m = new Map<string, { tableId: string; rowId: string; fieldKey: string }>();
  for (const t of vm?.tables ?? []) for (const r of t.rows) for (const [k, c] of Object.entries(r.cells)) if (c.jsonPointer && !m.has(c.jsonPointer)) m.set(c.jsonPointer, { tableId: t.id, rowId: r.id, fieldKey: k });
  return m;
}

function Banner({ tone, children }: { tone: "warn" | "bad" | "info"; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        "rise mx-3 mt-2 rounded-lg border px-3 py-2 text-[12px]",
        tone === "warn" && "border-risk/30 bg-risk/10 text-risk",
        tone === "bad" && "border-stamp/40 bg-stamp/10 text-stamp",
        tone === "info" && "border-info/30 bg-info/10 text-info",
      )}
    >
      {children}
    </div>
  );
}

/** 已等待秒数（每秒刷新） */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}</>;
}

export function ResultPane({
  detail,
  dirty,
  canPreview,
  loading,
  onCancel,
  onRetry,
  emptyHint,
}: {
  detail?: RunDetail;
  dirty: boolean;
  canPreview: boolean;
  loading: boolean;
  onCancel?: (runId: string) => void;
  /** 原样重试失败 / 取消的模型运行 */
  onRetry?: (runId: string) => void;
  /** 还没有结果时的引导（按当前 Prompt 是否有样本、模型是否已配置给出） */
  emptyHint: string;
}) {
  const tab = useStudio((s) => s.resultTab);
  const setStore = useStudio((s) => s.set);
  const maximized = useStudio((s) => s.maximized);
  const evidenceOpen = useStudio((s) => s.evidenceOpen);
  const run = detail?.run;
  const vm = run?.view_model ?? undefined;
  // 成功但没有业务视图（未登记 Schema，如通用 JSON）：打开时直接显示 JSON 树；只在换到另一条 Run 时切一次
  const noViewRunId = run && run.status === "SUCCEEDED" && !vm ? run.run_id : null;
  useEffect(() => {
    if (noViewRunId && useStudio.getState().resultTab === "visual") setStore("resultTab", "json");
  }, [noViewRunId, setStore]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="result-pane">
      <div className="flex items-center gap-1 border-b border-ink-700 bg-ink-900 px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setStore("resultTab", t.id)}
            className={cx("rounded-lg px-3 py-1 text-[13px] transition-colors", tab === t.id ? "bg-ink-800 font-medium text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100")}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {run && (
            <>
              <Badge tone="mute">{run.mode}</Badge>
              <Badge tone={runStatusView(run.status, run.schema_id).tone} title={run.status}>
                {runStatusView(run.status, run.schema_id).label}
              </Badge>
            </>
          )}
          <Btn onClick={() => setStore("evidenceOpen", !evidenceOpen)} aria-pressed={evidenceOpen}>
            来源
          </Btn>
          <Btn onClick={() => setStore("maximized", !maximized)} title="结果区放大 / 还原">
            {maximized ? "⤡ 还原" : "⤢ 放大"}
          </Btn>
        </div>
      </div>

      {run?.status === "RUNNING" && (
        <Banner tone="info">
          <span data-testid="running-banner">
            模型运行中… 已等待 <Elapsed since={Date.parse(run.started_at)} /> 秒（超时上限约 300 秒）。结果返回后自动显示；刷新或关闭页面不影响这次运行。
          </span>
          {onCancel && (
            <Btn tone="danger" className="ml-2" onClick={() => onCancel(run.run_id)} title="停止等待模型结果；服务商可能已开始处理并计费">
              取消运行
            </Btn>
          )}
        </Banner>
      )}
      {run?.finish_reason === "length" && (
        <Banner tone="bad">模型输出达到 max_tokens 上限被截断（finish_reason=length）。请在「模型」页调大 max_tokens 后重跑。</Banner>
      )}
      {dirty && run && <Banner tone="warn">当前结果来自上次运行（与未保存/未运行的编辑不同）。</Banner>}
      {run?.status === "PARSE_ERROR" && <Banner tone="bad">原始回复不是合法 JSON：不生成任何业务表格。请在「原始 JSON」查看原文与错误位置。</Banner>}
      {run?.status === "SCHEMA_INVALID" && <Banner tone="warn">JSON 合法但 Schema 校验未通过（SCHEMA_INVALID）：下方为可安全理解部分的局部渲染，非完整结果。</Banner>}
      {run?.status === "ADAPTER_ERROR" && <Banner tone="bad">适配器异常（ADAPTER_ERROR）：已保留原始 JSON 与校验结果，详见「结构校验」。</Banner>}
      {run?.status === "MODEL_ERROR" && (
        <Banner tone="bad">
          <div data-testid="model-error">
            <div>
              模型调用失败：{explainModelError(run.error?.code).title}。{explainModelError(run.error?.code).advice}
            </div>
            <details className="mt-0.5 text-[11px] opacity-80">
              <summary className="cursor-pointer">详情（已保存失败 Run，未回退为 Mock 结果）</summary>
              <div className="font-mono break-all">
                {run.error?.code} — {run.error?.message}
              </div>
            </details>
          </div>
        </Banner>
      )}
      {run?.status === "CANCELLED" && <Banner tone="warn">这次运行已取消，没有取得模型结果（服务商可能已开始处理并计费）。</Banner>}
      {run && onRetry && run.mode === "MODEL_RUN" && (run.status === "MODEL_ERROR" || run.status === "CANCELLED") && (
        <div className="mx-3 mt-1 flex items-center gap-2 text-[11.5px] text-ink-400">
          <Btn tone="outline" onClick={() => onRetry(run.run_id)} disabled={!run.prompt_source} data-testid="btn-retry" title={run.prompt_source ? "用同一快照、同一提示词原文和参数新建一次运行，原记录不变" : "这条记录没有保存提示词原文（v1.1 之前），无法原样重试"}>
            原样重试
          </Btn>
          {run.prompt_source ? "同一快照、同一提示词原文与参数，新建 Run；原失败记录保留。" : "这条记录早于 v1.1，没有保存提示词原文，不能原样重试。"}
        </div>
      )}
      {run?.input_manifest && !run.input_manifest.complete && run.status !== "RUNNING" && (
        <Banner tone="bad">
          <span data-testid="incomplete-input-banner">这次运行不是完整输入（{run.input_manifest.gaps[0]}）。结果不能作为完整材料识别评测，详见「运行信息 → 输入覆盖」。</span>
        </Banner>
      )}
      {run && !vm && run.status === "SUCCEEDED" && <Banner tone="info">未登记 Schema（UNKNOWN_SCHEMA）：不套用九立模板，请在「原始 JSON」查看 JSON 树，或选择正确的 Prompt/Schema。</Banner>}
      {run?.rerender_note && <Banner tone="info">{run.rerender_note}（原始结果 Hash 未变：{run.raw_response_hash.slice(0, 12)}…）</Banner>}

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3" data-testid={`tab-${tab}`}>
        {loading && <p className="text-ink-400">处理中…</p>}
        {!run && !loading && (
          <div className="rise mx-auto mt-[14vh] max-w-md px-6 text-center">
            <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-2xl border border-ink-700 bg-ink-900 font-mono text-[15px] text-ink-400 shadow-sm">{"{ }"}</div>
            <div className="mb-1.5 text-[15px] font-semibold text-ink-100">还没有运行结果</div>
            <p className="text-[12.5px] leading-6 text-ink-400">{emptyHint}</p>
          </div>
        )}
        {run && tab === "visual" && (vm && detail?.renderer ? <BusinessView vm={vm} cfg={detail.renderer} canPreview={canPreview} /> : <Empty>{run.status === "SUCCEEDED" ? "无业务视图（未登记 Schema）。" : "没有可展示的业务视图。"}</Empty>)}
        {run && tab === "json" && <JsonTab detail={detail!} />}
        {run && tab === "schema" && <SchemaTab detail={detail!} />}
        {run && tab === "meta" && <MetaTab detail={detail!} />}
      </div>

      {evidenceOpen && run && (
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-ink-700 bg-ink-900/95" data-testid="evidence-drawer">
          <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
            <span className="text-[12px] font-semibold">来源与标注</span>
            <button onClick={() => setStore("evidenceOpen", false)} className="text-ink-400 hover:text-ink-100" aria-label="关闭来源抽屉">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
            <SelectionInfo />
            {vm ? <EvidenceViewer vm={vm} canPreview={canPreview} snapshotSource={detail?.snapshot?.source_type} /> : <p className="text-[12px] text-ink-400">无业务视图，无法定位来源。</p>}
            <AnnotationForm detail={detail!} />
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}

function SelectionInfo() {
  const sel = useStudio((s) => s.selection);
  const setStore = useStudio((s) => s.set);
  if (!sel.jsonPointer && !sel.rowId) return null;
  return (
    <div className="rounded-lg border border-ink-700 p-2 text-[11px] text-ink-300">
      <div>
        选中：<span className="font-mono">{[sel.tableId, sel.rowId, sel.fieldKey].filter(Boolean).join(" / ") || "—"}</span>
      </div>
      {sel.jsonPointer !== undefined && (
        <button onClick={() => setStore("resultTab", "json")} className="mt-0.5 font-mono break-all text-info hover:underline" data-testid="selection-pointer">
          {sel.jsonPointer || "(根)"}
        </button>
      )}
    </div>
  );
}

function JsonTab({ detail }: { detail: RunDetail }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const run = detail.run;
  const isReq = sel.jsonPointer?.startsWith("req:") ?? false;
  const [docPref, setDoc] = useState<"response" | "request" | null>(null);
  const doc = docPref ?? (isReq && detail.request ? "request" : "response");
  const pointer = sel.jsonPointer === undefined ? undefined : doc === "request" ? (isReq ? sel.jsonPointer.slice(4) : undefined) : isReq ? undefined : sel.jsonPointer;
  const index = useMemo(() => cellIndex(run.view_model), [run.view_model]);
  const target = doc === "request" ? detail.request : run.parsed_json;
  const found = pointer === undefined || target === undefined ? true : getByPointer(target, pointer).found;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex gap-0.5 rounded-lg bg-ink-800 p-0.5 text-[11.5px]">
          <button onClick={() => setDoc("response")} className={cx("px-2.5 py-0.5", doc === "response" ? "rounded-md bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
            模型原始响应
          </button>
          <button onClick={() => setDoc("request")} disabled={!detail.request} className={cx("px-2.5 py-0.5 disabled:opacity-40", doc === "request" ? "rounded-md bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
            请求上下文（快照）
          </button>
        </div>
        <Btn onClick={() => navigator.clipboard?.writeText(run.raw_response)}>复制原文</Btn>
        <span className="font-mono text-[11px] text-ink-400">sha256 {run.raw_response_hash.slice(0, 16)}…</span>
      </div>
      {!found && <p className="rounded-lg border border-risk/40 bg-risk/10 px-2 py-1 text-[12px] text-risk">无法定位：{pointer} 在当前文档中不存在。</p>}
      {sel.jsonPointer !== undefined && pointer === undefined && <p className="text-[12px] text-ink-400">所选对象位于{isReq ? "请求上下文" : "模型响应"}，请切换文档查看。</p>}
      <div className="rounded-lg border border-ink-700 bg-ink-950/70 p-2">
        {doc === "response" && run.parsed_json === undefined ? (
          <>
            {run.parse_diagnostics.map((d, i) => (
              <p key={i} className="mb-1 text-[12px] text-stamp">
                [{d.code}] {d.message}
              </p>
            ))}
            {run.raw_response ? <RawText text={run.raw_response} errorLine={Number(/第 (\d+) 行/.exec(run.parse_diagnostics.map((d) => d.message).join(" "))?.[1]) || undefined} /> : <Empty>原始回复为空</Empty>}
          </>
        ) : (
          <JsonTree
            value={target}
            highlight={pointer}
            onSelect={(p) => {
              const full = doc === "request" ? "req:" + p : p;
              const hit = index.get(full);
              select({ jsonPointer: full, ...(hit ?? {}) });
            }}
          />
        )}
      </div>
    </div>
  );
}

function SchemaTab({ detail }: { detail: RunDetail }) {
  const run = detail.run;
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const diags = run.view_model?.diagnostics ?? [...run.parse_diagnostics, ...run.schema_diagnostics];
  const status = run.status === "PARSE_ERROR" ? "NOT_RUN" : !run.schema_id ? "UNKNOWN_SCHEMA" : run.schema_diagnostics.some((d) => d.level === "ERROR") ? "INVALID" : "VALID";
  const goto = (p?: string) => {
    if (p === undefined) return;
    select({ jsonPointer: p });
    setStore("resultTab", "json");
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status === "VALID" ? "ok" : status === "INVALID" ? "warn" : status === "NOT_RUN" ? "bad" : "info"}>{status}</Badge>
        <span className="text-[12px] text-ink-300">Schema：{run.schema_id ?? "未登记"}（{run.schema_version ?? "—"}）</span>
        <span className="text-[11px] text-ink-400">Schema 由 Studio 依据文档推导，非九立官方；合法 ≠ 事实准确。</span>
      </div>
      {(["PARSE", "SCHEMA", "ADAPTER", "RENDER"] as const).map((phase) => {
        const list = diags.filter((d) => d.phase === phase);
        if (!list.length) return null;
        return (
          <div key={phase}>
            <h4 className="mb-1 text-[11.5px] font-semibold text-ink-300">
              {phase} · {list.length}
            </h4>
            <table className="w-full text-[12px]">
              <tbody>
                {list.map((d, i) => (
                  <tr key={i} className="border-b border-ink-800">
                    <td className="w-16 py-1 pr-2">
                      <Badge tone={d.level === "ERROR" ? "bad" : d.level === "WARNING" ? "warn" : "info"}>{d.level}</Badge>
                    </td>
                    <td className="w-56 py-1 pr-2 font-mono text-[11px] text-ink-400">{d.code}</td>
                    <td className="py-1 pr-2 break-words">{d.message}</td>
                    <td className="py-1">
                      {d.jsonPointer !== undefined && (
                        <button onClick={() => goto(d.jsonPointer)} className="font-mono text-[11px] break-all text-info hover:underline" data-testid="diag-pointer">
                          {d.jsonPointer || "/"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!diags.length && <Empty>没有诊断信息。</Empty>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="border-b border-ink-800 px-3.5 py-1.5 text-ink-400">{k}</dt>
      <dd className="border-b border-ink-800 px-3.5 py-1.5 font-mono break-all">{v ?? <span className="text-ink-600">unknown</span>}</dd>
    </>
  );
}

function MetaTab({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  const [showPrompt, setShow] = useState(false);
  return (
    <div className="space-y-3 text-[12px]">
      <dl className="grid grid-cols-[180px_1fr] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 [&>*:nth-last-child(-n+2)]:border-b-0">
        <Row k="run_id" v={r.run_id} />
        <Row k="模式 / 状态" v={`${r.mode} / ${r.status}`} />
        <Row k="标签" v={r.label} />
        <Row k="Prompt / 种类" v={`${r.prompt_id} / ${r.prompt_kind}`} />
        <Row
          k="Prompt 版本"
          v={
            r.prompt_version_id
              ? `${detail.prompt_version_label ? `${detail.prompt_version_label}（${r.prompt_version_id}）` : r.prompt_version_id}${r.is_unsaved_draft ? "（运行时为基于此版本的未保存草稿）" : ""}`
              : r.mode === "RENDER_ONLY"
                ? "不适用（仅渲染）"
                : "未保存草稿"
          }
        />
        <Row k="实际提示词 Hash" v={r.actual_prompt_hash} />
        <Row k="构造输入 Hash" v={r.built_input_hash} />
        <Row k="输入构造器" v={r.input_builder_id} />
        <Row
          k="输入快照"
          v={
            detail.snapshot
              ? `${detail.snapshot.label}（${detail.snapshot.snapshot_id}，${detail.snapshot.source_type}，hash ${detail.snapshot.content_hash.slice(0, 12)}…）`
              : detail.snapshot_deleted_at
                ? `${r.input_snapshot_id}（已删除或到期：${detail.snapshot_deleted_at.slice(0, 19).replace("T", " ")}；原始输出不受影响）`
                : "无"
          }
        />
        <Row k="模型" v={r.model_provider ? `${r.model_provider} · ${r.model_name}` : "未调用模型"} />
        <Row k="Provider 适配器版本" v={r.provider_adapter_version} />
        <Row k="模型参数" v={r.model_params ? JSON.stringify(r.model_params) : null} />
        <Row k="附带原件图片" v={r.attached_images ? (r.attached_images.length ? r.attached_images.map((i) => `${i.file_id}${i.page ? ` 第${i.page}页` : ""}`).join("，") : "已开启，但没有可附带的图片") : null} />
        <Row k="Schema" v={r.schema_id ? `${r.schema_id} (${r.schema_version})` : null} />
        <Row k="Adapter" v={r.adapter_id ? `${r.adapter_id}@${r.adapter_version}` : null} />
        <Row k="RendererConfig 版本" v={r.renderer_config_version} />
        <Row k="开始 / 结束" v={`${r.started_at} → ${r.ended_at ?? "—"}`} />
        <Row k="耗时" v={r.latency_ms != null ? `${r.latency_ms} ms` : null} />
        <Row
          k="分阶段耗时"
          v={r.timing ? `预处理 ${r.timing.preprocess_ms ?? "—"} ms · 模型 ${r.timing.inference_ms ?? "—"} ms · 解析与渲染 ${r.timing.parse_ms ?? "—"} ms` : r.mode === "MODEL_RUN" ? "未记录（v1.1 之前的 Run）" : "不适用"}
        />
        <Row k="服务商请求 ID" v={r.provider_request_id} />
        <Row k="重试来源" v={r.retry_of_run_id} />
        <Row k="Token" v={r.token_usage ? JSON.stringify(r.token_usage) : null} />
        <Row k="结束原因" v={r.finish_reason ? `${r.finish_reason}${r.finish_reason === "length" ? "（达到 max_tokens 被截断）" : ""}` : null} />
        <Row k="费用" v={r.estimated_cost ? `${r.estimated_cost.value} ${r.estimated_cost.currency}（${r.estimated_cost.basis}）` : "未知（服务商未返回价格，Studio 不估算）"} />
        <Row k="原始响应 sha256" v={r.raw_response_hash} />
        <Row k="回放来源" v={r.replay_of_run_id} />
        <Row k="错误" v={r.error ? `${r.error.code}: ${r.error.message}` : "无"} />
      </dl>
      {r.input_manifest ? <InputCoverage manifest={r.input_manifest} /> : r.mode === "MODEL_RUN" && <p className="text-[11.5px] text-ink-400">这条 Run 早于 v1.1，没有输入覆盖清单。</p>}
      {detail.snapshot?.warnings?.length ? (
        <div className="rounded-lg border border-risk/30 p-2 text-[11.5px] text-risk">
          {detail.snapshot.warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      ) : null}
      {r.input_builder_warnings?.length ? <div className="text-[11.5px] text-risk">{r.input_builder_warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div> : null}
      {r.actual_prompt && (
        <div>
          <Btn tone="outline" onClick={() => setShow((s) => !s)}>
            {showPrompt ? "收起" : "查看"}实际发送内容（已脱敏）
          </Btn>
          {showPrompt && (
            <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-2 text-[11px] whitespace-pre-wrap">
              {`# system\n${r.actual_prompt.system}\n\n# user\n${r.actual_prompt.user}`}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 全部类型的显示名（含旧数据里的"正确值""错误原因"，照常显示与导出） */
const ANN_LABEL: Record<string, string> = {
  MODEL_WRONG: "模型错了",
  CORRECT_VALUE: "正确值",
  ERROR_REASON: "错误原因",
  CORRECT_CANDIDATE: "正确候选（P3）",
  WRONG_RELATION: "错误关系（P3）",
  NOTE: "备注",
};
/** 新建时可选的类型：正确值、错误原因直接填下方输入框，不再作为单独类型；P3 才有候选/关系类型 */
const annTypeChoices = (kind: string) => ["MODEL_WRONG", ...(kind === "JIULI_P3" ? ["CORRECT_CANDIDATE", "WRONG_RELATION"] : []), "NOTE"];

/** 纠错标注独立保存，不修改模型输出、九立池或原始附件 */
function AnnotationForm({ detail }: { detail: RunDetail }) {
  const sel = useStudio((s) => s.selection);
  const putRun = useStudio((s) => s.putRun);
  const [type, setType] = useState("MODEL_WRONG");
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** 正在修改的标注；为空时表单用于新增 */
  const [editing, setEditing] = useState<AnnotationDTO | null>(null);
  const [saved, setSaved] = useState(false);
  const choices = annTypeChoices(detail.run.prompt_kind);
  // 修改旧标注时保留它原来的类型
  if (editing && !choices.includes(editing.issue_type)) choices.push(editing.issue_type);
  const target = [sel.tableId, sel.rowId, sel.fieldKey].filter(Boolean).join(" / ") || sel.relationId || null;

  function reset() {
    setEditing(null);
    setType("MODEL_WRONG");
    setExpected("");
    setNote("");
  }

  async function save() {
    setErr(null);
    try {
      if (editing) {
        const a = await api<AnnotationDTO>(`/api/annotations/${editing.annotation_id}`, { method: "PATCH", json: { issue_type: type, expected_value: expected, note } });
        putRun({ ...detail, annotations: detail.annotations.map((x) => (x.annotation_id === a.annotation_id ? a : x)) });
      } else {
        const a = await api<AnnotationDTO>(`/api/runs/${detail.run.run_id}/annotations`, { json: { issue_type: type, expected_value: expected || undefined, note: note || undefined, target_json_pointer: sel.jsonPointer, target } });
        putRun({ ...detail, annotations: [...detail.annotations, a] });
      }
      reset();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function startEdit(a: AnnotationDTO) {
    setErr(null);
    setEditing(a);
    setType(a.issue_type);
    setExpected(a.expected_value ?? "");
    setNote(a.note ?? "");
  }

  async function remove(a: AnnotationDTO) {
    if (!window.confirm("删除这条标注？删除后不再显示、不进入导出（系统保留删除记录）。")) return;
    setErr(null);
    try {
      await api(`/api/annotations/${a.annotation_id}`, { method: "DELETE" });
      putRun({ ...detail, annotations: detail.annotations.filter((x) => x.annotation_id !== a.annotation_id) });
      if (editing?.annotation_id === a.annotation_id) reset();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="border-t border-ink-700 pt-2" data-testid="annotation-form">
      <h4 className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-ink-300">
        评测标注（独立保存，不改模型输出）
        <span className="ml-auto font-normal">
          导出全部：
          <a href={`/api/annotations/export?project=${detail.run.project_id}&format=csv`} className="text-info hover:underline" data-testid="export-annotations-csv">
            CSV
          </a>
          {" / "}
          <a href={`/api/annotations/export?project=${detail.run.project_id}&format=json`} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">
            JSON
          </a>
        </span>
      </h4>
      <div className="space-y-1.5">
        <div className="text-[11px] text-ink-400">{editing ? `正在修改：${editing.target ?? editing.target_json_pointer ?? "整个 Run"}` : `目标：${target ?? "（未选择，标注整个 Run）"}`}</div>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="标注类型" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-1 py-0.5 text-[12px]">
          {choices.map((v) => (
            <option key={v} value={v}>
              {ANN_LABEL[v] ?? v}
            </option>
          ))}
        </select>
        <input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="正确值（可选）" aria-label="正确值" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5 text-[12px]" />
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="错误原因 / 备注（可选）" aria-label="标注备注" rows={2} className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5 text-[12px]" />
        <div className="flex gap-1">
          <Btn tone="outline" onClick={save}>
            {editing ? "保存修改" : "保存标注"}
          </Btn>
          {editing && <Btn onClick={reset}>取消修改</Btn>}
          {saved && (
            <span className="self-center text-[11px] text-verify" role="status">
              已保存
            </span>
          )}
        </div>
        {err && <p className="text-[11px] text-stamp">{err}</p>}
      </div>
      {detail.annotations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {detail.annotations.map((a) => (
            <li key={a.annotation_id} className={cx("rounded-lg bg-ink-800 px-2 py-1 text-[11px]", editing?.annotation_id === a.annotation_id && "ring-1 ring-info")}>
              <div className="flex items-center gap-1">
                <Badge tone="info">{ANN_LABEL[a.issue_type] ?? a.issue_type}</Badge> <span className="min-w-0 flex-1 truncate text-ink-400">{a.target ?? a.target_json_pointer}</span>
                <button onClick={() => startEdit(a)} className="text-info hover:underline" aria-label={`修改标注 ${a.annotation_id}`}>
                  修改
                </button>
                <button onClick={() => remove(a)} className="text-stamp hover:underline" aria-label={`删除标注 ${a.annotation_id}`}>
                  删除
                </button>
              </div>
              {a.expected_value && <div>正确值：{a.expected_value}</div>}
              {a.note && <div className="text-ink-300">{a.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
