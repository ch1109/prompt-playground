"use client";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, getLayout } from "@/lib/client/api";
import { applyLayout } from "@/lib/layouts/apply";
import type { StoredLayout } from "@/lib/layouts/types";
import { LayoutView } from "@/components/views/layout-view";
import { LayoutEditor } from "./layout-editor";
import { ISSUE_VERDICT_LABEL, issueIdOfTarget, issueSummaryOfTarget, type AnnotationDTO, type FixtureSummary, type RunDetail, type RunListItem } from "@/lib/client/types";
import type { CellState, ViewModel } from "@/lib/contracts/view-model";
import { explainModelError } from "@/lib/models/error-hints";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { useStudio, type ResultTab } from "@/lib/state/studio-store";
import { EvidenceViewer, selectedRefIds } from "@/components/renderers/evidence-viewer";
import { describeEgress } from "@/lib/runs/egress-text";
import { fieldInputCoverage } from "@/lib/runs/run-evidence";
import { diagnosisPrompt } from "@/lib/mcp/task-template";
import { BusinessView } from "@/components/views/business-view";
import { RuleCheck } from "@/components/views/rule-check";
import { Badge, Btn, CloseBtn, cx, Empty, RUN_STATUS_LABEL, runStatusView, SEG_TRACK, segItem } from "@/components/ui";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { JsonTree, RawText } from "./json-tree";
import { InputCoverage } from "./input-coverage";
import { RunEvidencePanel } from "./run-evidence-panel";

// 平时只看「结果」和「原始输出」；结构校验、运行信息、输入覆盖都收在「详情」
const TABS: { id: ResultTab; label: string }[] = [
  { id: "visual", label: "结果" },
  { id: "json", label: "原始输出" },
  { id: "details", label: "详情" },
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
        "rise mx-5 mt-3 rounded-xl border px-4 py-2.5 text-[12px]",
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
  projectId,
  detail,
  dirty,
  canPreview,
  loading,
  onCancel,
  onRetry,
  emptyHint,
  recentRun,
  onOpenRun,
  example,
  onOpenExample,
  toolbar,
}: {
  projectId: string;
  detail?: RunDetail;
  dirty: boolean;
  canPreview: boolean;
  loading: boolean;
  onCancel?: (runId: string) => void;
  /** 原样重试失败 / 取消的模型运行 */
  onRetry?: (runId: string) => void;
  /** 还没有结果时的引导（按当前 Prompt 是否有样本、模型是否已配置给出） */
  emptyHint: string;
  /** 当前 Prompt 最近一次 Run（空状态入口） */
  recentRun?: RunListItem;
  onOpenRun?: (runId: string) => void;
  /** 空状态示例样本（明确标为 Fixture） */
  example?: FixtureSummary;
  onOpenExample?: (fixtureId: string) => void;
  /** 放在结果页签同一行的额外内容（结果检查模式的「当前输入」） */
  toolbar?: ReactNode;
}) {
  const tab = useStudio((s) => s.resultTab);
  const setStore = useStudio((s) => s.set);
  const evidenceOpen = useStudio((s) => s.evidenceOpen);
  const run = detail?.run;
  const vm = run?.view_model ?? undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="result-pane">
      <div className="flex items-center gap-4 border-b border-ink-700 bg-ink-900 px-5 py-2.5">
        <div className={cx(SEG_TRACK, "shrink-0")}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setStore("resultTab", t.id)}
            className={segItem(tab === t.id)}
          >
            {t.label}
          </button>
        ))}
        </div>
        {toolbar}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 有业务视图时，结果头部第一句已说明是哪种结果，这里不再重复 */}
          {run && !(run.view_model && detail?.renderer) && (
            <Badge tone={runStatusView(run.status, run.schema_id, run.prompt_kind, run.mode).tone} title={run.status}>
              {runStatusView(run.status, run.schema_id, run.prompt_kind, run.mode).label}
            </Badge>
          )}
          {run && run.status !== "RUNNING" && (
            <a
              href={`/api/runs/${run.run_id}/export`}
              download
              data-testid="btn-export-context"
              className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-ink-300 hover:bg-ink-800 hover:text-ink-100"
              title="下载这次运行的完整上下文（ZIP）：实际提示词、用户输入、模型思考与输出、你的标注、检查结果，以及用到的原件。可以交给 Claude Code / Codex 改提示词——原件会一起发给对方"
            >
              导出上下文
            </a>
          )}
          <Btn onClick={() => setStore("evidenceOpen", !evidenceOpen)} aria-pressed={evidenceOpen}>
            来源
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
        <Banner tone="bad"><span title="finish_reason=length">模型的回答太长，被截断了。请在「提示词」页的「运行参数」里把 max_tokens 调大后重新运行。</span></Banner>
      )}
      {dirty && run && <Banner tone="warn">当前结果来自上次运行（与未保存/未运行的编辑不同）。</Banner>}
      {run?.mode === "RENDER_ONLY" && (detail?.snapshot?.source_type === "FIXTURE" || run.label?.startsWith("样本")) && (
        <Banner tone="info">
          <span data-testid="fixture-banner">这是示例结果，不是模型本次运行；{detail?.snapshot?.warnings.some((w) => w.includes("录制")) ? "录制的模型输出不是标准答案。" : "不能用来说明准确率。"}</span>
        </Banner>
      )}
      {run?.status === "PARSE_ERROR" && <Banner tone="bad">模型回答不是合法 JSON，没有生成表格。请在「原始输出」查看原文与出错位置。</Banner>}
      {run?.status === "SCHEMA_INVALID" && <Banner tone="warn">模型回答的结构不完全符合约定：下方只显示能确定的部分，不是完整结果。具体问题见「详情」。</Banner>}
      {run?.status === "ADAPTER_ERROR" && <Banner tone="bad">把结果整理成表格时出错：原始输出已保留，具体原因见「详情」。</Banner>}
      {run?.status === "MODEL_ERROR" && (
        <Banner tone="bad">
          <div data-testid="model-error">
            <div>
              模型调用失败：{explainModelError(run.error?.code).title}。{explainModelError(run.error?.code).advice}
            </div>
            <details className="mt-0.5 text-[11px] opacity-80">
              <summary className="cursor-pointer">详情（失败记录已保存，没有用假结果代替）</summary>
              <div className="font-mono break-all">
                {run.error?.code} — {run.error?.message}
              </div>
            </details>
          </div>
        </Banner>
      )}
      {run?.status === "CANCELLED" && <Banner tone="warn">这次运行已取消，没有取得模型结果（服务商可能已开始处理并计费）。</Banner>}
      {run && onRetry && run.mode === "MODEL_RUN" && (run.status === "MODEL_ERROR" || run.status === "CANCELLED") && (
        <div className="mx-5 mt-1 flex items-center gap-2 text-[11.5px] text-ink-400">
          <Btn tone="outline" onClick={() => onRetry(run.run_id)} disabled={!run.prompt_source} data-testid="btn-retry" title={run.prompt_source ? "用同一输入、同一提示词和参数再运行一次，原记录不变" : "这条记录较早，当时没有保存提示词原文，无法原样重试"}>
            原样重试
          </Btn>
          {run.prompt_source ? "用同一输入、同一提示词和参数再运行一次；原失败记录保留。" : "这条记录较早，当时没有保存提示词原文，不能原样重试。"}
        </div>
      )}
      {run?.input_manifest && !run.input_manifest.complete && run.status !== "RUNNING" && (
        <Banner tone="bad">
          <span data-testid="incomplete-input-banner">这次发给模型的输入不完整（{run.input_manifest.gaps[0]}），结果不能当作完整识别来评判。详见「详情 → 输入覆盖」。</span>
        </Banner>
      )}
      {run && !vm && run.status === "SUCCEEDED" && run.prompt_kind !== "GENERIC_JSON" && <Banner tone="info">这个回答不符合九立预设的结构，没有套用九立表格，下方按 JSON 树显示。</Banner>}
      {detail?.evidence?.warnings.map((w) => (
        <Banner key={w.code} tone="warn">
          <span data-testid="schema-version-mismatch">{w.label}：{w.reason}</span>
        </Banner>
      ))}
      {run?.rerender_note && (
        <Banner tone="info">
          <span title={run.rerender_note}>这是按当前显示规则重新整理的结果，模型原始输出没有改动。</span>
        </Banner>
      )}

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-5" data-testid={`tab-${tab}`}>
        {loading && <p className="text-ink-400">处理中…</p>}
        {!run && !loading && (
          <div className="rise mx-auto mt-[14vh] max-w-md px-6 text-center">
            <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-2xl border border-ink-700 bg-ink-900 font-mono text-[15px] text-ink-400 shadow-sm">{"{ }"}</div>
            <div className="mb-1.5 text-[15px] font-semibold text-ink-100">还没有运行结果</div>
            <p className="text-[12.5px] leading-6 text-ink-400">{emptyHint}</p>
            <div className="mt-4 flex flex-col items-center gap-2" data-testid="empty-actions">
              {recentRun && onOpenRun && (
                <Btn tone="outline" onClick={() => onOpenRun(recentRun.run_id)} data-testid="open-recent-run">
                  打开最近一次运行：{recentRun.label || recentRun.run_id}（{recentRun.started_at.slice(5, 16).replace("T", " ")} · {runStatusView(recentRun.status, recentRun.schema_id, recentRun.prompt_kind, recentRun.mode).label}）
                </Btn>
              )}
              {example && onOpenExample && (
                <Btn onClick={() => onOpenExample(example.id)} data-testid="open-example" title="直接显示一个示例，不调用模型；结果会标明是示例">
                  查看示例结果（{example.title}）
                </Btn>
              )}
            </div>
          </div>
        )}
        {run && tab === "visual" && <ResultTab projectId={projectId} detail={detail!} canPreview={canPreview} />}
        {run && tab === "json" && <JsonTab detail={detail!} />}
        {run && tab === "details" && (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-[13px] font-semibold">运行信息</h3>
              <MetaTab detail={detail!} />
            </section>
            <section>
              <h3 className="mb-2 text-[13px] font-semibold">结构校验</h3>
              <SchemaTab detail={detail!} />
            </section>
          </div>
        )}
      </div>

      {evidenceOpen && run && (
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-ink-700 bg-ink-900" data-testid="evidence-drawer">
          <div className="flex items-center justify-between border-b border-ink-700 py-2.5 pr-3 pl-4">
            <span className="text-[13px] font-semibold tracking-tight">来源与标注</span>
            <CloseBtn onClick={() => setStore("evidenceOpen", false)} label="关闭来源抽屉" />
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
            <SelectionInfo />
            <IssueVerdict detail={detail!} />
            <FieldVerdict detail={detail!} />
            <AnnotationForm detail={detail!}>
              {vm ? <EvidenceViewer vm={vm} canPreview={canPreview} snapshotSource={detail?.snapshot?.source_type} request={detail?.request} /> : <p className="text-[12px] text-ink-400">无业务视图，无法定位来源。</p>}
            </AnnotationForm>
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}

/** 「结果」：九立预设显示业务视图；其他情况按 JSON 树（回答是 JSON）或文本（回答是文字）显示 */
function ResultTab({ projectId, detail, canPreview }: { projectId: string; detail: RunDetail; canPreview: boolean }) {
  const run = detail.run;
  if (run.view_model && detail.renderer) return <BusinessView vm={run.view_model} cfg={detail.renderer} canPreview={canPreview} status={run.status} mode={run.mode} afterHeadline={<RuleCheck detail={detail} />} />;
  if (run.status !== "SUCCEEDED") return <Empty>没有可展示的结果，原因见上方提示。</Empty>;
  if (run.parsed_json !== undefined) {
    if (run.prompt_kind === "GENERIC_JSON") return <GenericJsonResult projectId={projectId} run={run} />;
    return <JsonResult value={run.parsed_json} />;
  }
  return (
    <div className="prompt-md max-w-3xl rounded-xl border border-ink-700 bg-ink-900 px-6 py-5" data-testid="result-text">
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{run.raw_response}</Markdown>
    </div>
  );
}

function JsonResult({ value }: { value: unknown }) {
  const select = useStudio((s) => s.select);
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/70 p-2" data-testid="result-json">
      <JsonTree value={value} onSelect={(p) => select({ jsonPointer: p })} />
    </div>
  );
}

const KIND_NAME = { table: "表格", cards: "卡片", checklist: "清单", report: "报告" } as const;
/** 同一提示词的版式只请求一次；保存后刷新 */
const layoutCache = new Map<string, StoredLayout | null>();

/** 通用提示词的 JSON 输出：有版式就按版式显示，没有就是 JSON 树 */
function GenericJsonResult({ projectId, run }: { projectId: string; run: RunDetail["run"] }) {
  const promptId = run.prompt_id;
  const [, bump] = useState(0);
  const [loaded, setLoaded] = useState(layoutCache.has(promptId));
  const [showTree, setShowTree] = useState(false);
  const [editing, setEditing] = useState(false);
  const stored = layoutCache.get(promptId) ?? null;

  useEffect(() => {
    if (layoutCache.has(promptId)) return setLoaded(true);
    setLoaded(false);
    let alive = true;
    getLayout(promptId)
      .then((r) => layoutCache.set(promptId, r.layout))
      .catch(() => layoutCache.set(promptId, null))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [promptId]);

  const result = useMemo(() => (stored ? applyLayout(stored.layout, run.parsed_json) : null), [stored, run.parsed_json]);
  const link = "text-[12px] text-ink-400 hover:text-ink-100 hover:underline";
  return (
    <div className="space-y-2">
      {loaded && (
        <div className="flex items-center justify-end gap-3">
          {stored ? (
            <>
              <span className="text-[12px] text-ink-400">
                版式：{KIND_NAME[stored.layout.kind]} ·{" "}
                <button onClick={() => setEditing(true)} className="hover:text-ink-100 hover:underline" data-testid="layout-adjust">
                  调整
                </button>
              </span>
              <button onClick={() => setShowTree((v) => !v)} className={link} data-testid="layout-toggle-tree">
                {showTree ? "看版式" : "看 JSON 树"}
              </button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} className={link} data-testid="layout-generate">
              生成版式
            </button>
          )}
        </div>
      )}
      {result && !showTree && <LayoutView result={result} />}
      {(!result || showTree || result.kind === "mismatch") && <JsonResult value={run.parsed_json} />}
      {editing && (
        <LayoutEditor
          projectId={projectId}
          promptId={promptId}
          runId={run.run_id}
          sample={run.parsed_json}
          initial={stored?.layout ?? null}
          onClose={() => setEditing(false)}
          onSaved={() => {
            layoutCache.delete(promptId);
            setEditing(false);
            getLayout(promptId)
              .then((r) => layoutCache.set(promptId, r.layout))
              .finally(() => bump((n) => n + 1));
          }}
        />
      )}
    </div>
  );
}

function SelectionInfo() {
  const sel = useStudio((s) => s.selection);
  const setStore = useStudio((s) => s.set);
  if (!sel.jsonPointer && !sel.rowId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
      <span>
        选中：<span className="text-ink-100">{sel.rowId || sel.relationId || "—"}</span>
      </span>
      {sel.jsonPointer !== undefined && (
        <button onClick={() => setStore("resultTab", "json")} title={sel.jsonPointer || "(根)"} className="ml-auto text-info hover:underline" data-testid="selection-pointer">
          查看 JSON 位置
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
        <div className={SEG_TRACK}>
          <button onClick={() => setDoc("response")} className={segItem(doc === "response")}>
            模型原始响应
          </button>
          <button onClick={() => setDoc("request")} disabled={!detail.request} className={cx(segItem(doc === "request"), "disabled:opacity-40")}>
            发给模型的输入
          </button>
        </div>
        <Btn onClick={() => navigator.clipboard?.writeText(run.raw_response)} title={`原文 sha256：${run.raw_response_hash}`}>
          复制原文
        </Btn>
      </div>
      {!found && <p className="rounded-lg border border-risk/40 bg-risk/10 px-2 py-1 text-[12px] text-risk">无法定位：{pointer} 在当前文档中不存在。</p>}
      {sel.jsonPointer !== undefined && pointer === undefined && <p className="text-[12px] text-ink-400">所选对象位于{isReq ? "请求上下文" : "模型响应"}，请切换文档查看。</p>}
      <div className="rounded-xl border border-ink-700 bg-ink-900 p-3">
        {doc === "response" && run.parsed_json === undefined ? (
          <>
            {run.parse_diagnostics.map((d, i) => (
              <p key={i} title={d.code} className={cx("mb-2 text-[12px]", d.level === "INFO" ? "text-ink-400" : "text-stamp")}>
                {d.message}
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

const SCHEMA_STATUS_LABEL: Record<string, string> = { VALID: "符合约定", INVALID: "不符合约定", NOT_RUN: "没有校验", UNKNOWN_SCHEMA: "没有对应的结构定义" };
const PHASE_LABEL = { PARSE: "解析回答", SCHEMA: "结构校验", ADAPTER: "整理成表格", RENDER: "显示" } as const;
const LEVEL_LABEL: Record<string, string> = { ERROR: "错误", WARNING: "提醒", INFO: "提示" };
const MODE_LABEL: Record<string, string> = { MODEL_RUN: "模型运行", RENDER_ONLY: "仅渲染", REPLAY: "回放" };

function SchemaTab({ detail }: { detail: RunDetail }) {
  const run = detail.run;
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const diags = run.view_model?.diagnostics ?? [...run.parse_diagnostics, ...run.schema_diagnostics, ...(run.adapter_diagnostics ?? [])];
  const status = run.status === "PARSE_ERROR" ? "NOT_RUN" : !run.schema_id ? "UNKNOWN_SCHEMA" : run.schema_diagnostics.some((d) => d.level === "ERROR") ? "INVALID" : "VALID";
  const goto = (p?: string) => {
    if (p === undefined) return;
    select({ jsonPointer: p });
    setStore("resultTab", "json");
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status === "VALID" ? "ok" : status === "INVALID" ? "warn" : status === "NOT_RUN" ? "bad" : "info"} title={status}>{SCHEMA_STATUS_LABEL[status]}</Badge>
        <span className="text-[12px] text-ink-300">Schema：{run.schema_id ?? "未登记"}（{run.schema_version ?? "—"}）</span>
        <span className="text-[11px] text-ink-400">Schema 由 Studio 依据文档推导，非九立官方；合法 ≠ 事实准确。</span>
      </div>
      {(["PARSE", "SCHEMA", "ADAPTER", "RENDER"] as const).map((phase) => {
        const list = diags.filter((d) => d.phase === phase);
        if (!list.length) return null;
        return (
          <div key={phase}>
            <h4 className="mb-1 text-[11.5px] font-semibold text-ink-300">
              <span title={phase}>{PHASE_LABEL[phase]}</span> · {list.length}
            </h4>
            <table className="w-full text-[12px]">
              <tbody>
                {list.map((d, i) => (
                  <tr key={i} className="border-b border-ink-800">
                    <td className="w-16 py-1 pr-2">
                      <Badge tone={d.level === "ERROR" ? "bad" : d.level === "WARNING" ? "warn" : "info"} title={d.level}>{LEVEL_LABEL[d.level] ?? d.level}</Badge>
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
      <dd className="border-b border-ink-800 px-3.5 py-1.5 font-mono break-all">{v ?? <span className="text-ink-600">未记录</span>}</dd>
    </>
  );
}

function MetaTab({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  const [showPrompt, setShow] = useState(false);
  return (
    <div className="space-y-3 text-[12px]">
      {detail.evidence && r.status !== "RUNNING" && <RunEvidencePanel run={r} evidence={detail.evidence} />}
      <dl className="grid grid-cols-[180px_1fr] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 [&>*:nth-last-child(-n+2)]:border-b-0">
        <Row k="run_id" v={r.run_id} />
        <Row k="模式 / 状态" v={<span title={`${r.mode} / ${r.status}`}>{`${MODE_LABEL[r.mode] ?? r.mode} / ${RUN_STATUS_LABEL[r.status] ?? r.status}`}</span>} />
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
          k="输入记录"
          v={
            detail.snapshot
              ? `${detail.snapshot.label}（${detail.snapshot.snapshot_id}，${detail.snapshot.source_type}，hash ${detail.snapshot.content_hash.slice(0, 12)}…）`
              : detail.snapshot_deleted_at
                ? `${r.input_snapshot_id}（已删除或到期：${detail.snapshot_deleted_at.slice(0, 19).replace("T", " ")}；原始输出不受影响）`
                : "无"
          }
        />
        <Row k="模型" v={r.model_provider ? `${r.model_provider} · ${r.model_name}` : "未调用模型"} />
        {r.mode === "MODEL_RUN" && <Row k="外发" v={r.egress ? describeEgress(r.egress) : null} />}
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
          v={r.timing ? `预处理 ${r.timing.preprocess_ms ?? "—"} ms · 模型 ${r.timing.inference_ms ?? "—"} ms · 解析与渲染 ${r.timing.parse_ms ?? "—"} ms` : r.mode === "MODEL_RUN" ? "未记录（这条运行记录较早）" : "不适用"}
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
      {r.input_manifest ? <InputCoverage manifest={r.input_manifest} /> : r.mode === "MODEL_RUN" && <p className="text-[11.5px] text-ink-400">这条运行记录较早，当时没有保存输入覆盖清单。</p>}
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

/** 选中一条「问题」时：这条问题属实吗（属实 / 误报）。点一下直接保存；再点另一个就是修改 */
function IssueVerdict({ detail }: { detail: RunDetail }) {
  const sel = useStudio((s) => s.selection);
  const putRun = useStudio((s) => s.putRun);
  const [err, setErr] = useState<string | null>(null);
  const issue = sel.issueId ? detail.run.view_model?.issues.find((i) => i.id === sel.issueId) : undefined;
  if (!issue) return null;
  const cur = detail.annotations.find((a) => a.issue_type in ISSUE_VERDICT_LABEL && issueIdOfTarget(a.target) === issue.id);
  async function mark(type: string) {
    setErr(null);
    try {
      const a = await api<AnnotationDTO>(`/api/runs/${detail.run.run_id}/annotations`, { json: { issue_type: type, issue_id: issue!.id } });
      putRun({ ...detail, annotations: cur ? detail.annotations.map((x) => (x.annotation_id === a.annotation_id ? a : x)) : [...detail.annotations, a] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-900 p-2.5 text-[12px]" data-testid="issue-verdict-box">
      <div className="break-words text-ink-100">{issue.summary}</div>
      <div className="text-ink-400">这条问题属实吗？</div>
      <div className="flex gap-1.5">
        <Btn tone="outline" onClick={() => mark("ISSUE_REAL")} aria-pressed={cur?.issue_type === "ISSUE_REAL"} data-testid="btn-issue-real" className={cx(cur?.issue_type === "ISSUE_REAL" && "border-verify text-verify")}>
          属实
        </Btn>
        <Btn tone="outline" onClick={() => mark("ISSUE_FALSE_POSITIVE")} aria-pressed={cur?.issue_type === "ISSUE_FALSE_POSITIVE"} data-testid="btn-issue-false" className={cx(cur?.issue_type === "ISSUE_FALSE_POSITIVE" && "border-stamp text-stamp")}>
          误报
        </Btn>
      </div>
      {err && <p className="text-[11px] text-stamp">{err}</p>}
    </div>
  );
}

/** 选中字段的值、状态、实际输入；对 / 错的标注在下方 AnnotationForm */
function FieldVerdict({ detail }: { detail: RunDetail }) {
  const sel = useStudio((s) => s.selection);
  const [copied, setCopied] = useState(false);
  const p = sel.jsonPointer;
  if (!p || p.startsWith("req:") || !sel.fieldKey || detail.run.parsed_json === undefined) return null;
  const vm = detail.run.view_model;
  const table = vm?.tables.find((t) => t.id === sel.tableId);
  const col = table?.columns.find((c) => c.key === sel.fieldKey);
  const cell = table?.rows.find((r) => r.id === sel.rowId)?.cells[sel.fieldKey];
  const hit = getByPointer(detail.run.parsed_json, p);
  // 业务表显示的值与模型原始输出不同 → 是 Adapter 整理时转换的（只是补了中文说明的不算，例如「FILL（补空）」）
  const converted = cell && hit.found && JSON.stringify(cell.value) !== JSON.stringify(hit.value) && !(typeof cell.value === "string" && typeof hit.value === "string" && cell.value.startsWith(`${hit.value}（`));
  const parentPointer = p.slice(0, p.lastIndexOf("/"));
  const parent = parentPointer ? getByPointer(detail.run.parsed_json, parentPointer) : undefined;
  const refs = vm ? (selectedRefIds(vm, sel) ?? []) : [];
  const coverage = vm ? fieldInputCoverage(refs.map((id) => vm.evidence.find((e) => e.id === id)).filter((e) => !!e), detail.run.input_manifest, detail.run.mode) : [];
  const wrong = detail.annotations.find((a) => a.target_json_pointer === p && a.assessment === "WRONG");
  function copyDiagnosis() {
    const text = diagnosisPrompt({
      runId: detail.run.run_id,
      stage: detail.run.prompt_kind.replace(/^JIULI_/, ""),
      objectRef: sel.rowId ? { table_id: sel.tableId ?? undefined, row_id: sel.rowId, field: sel.fieldKey ?? undefined } : { json_pointer: p! },
      expectedValue: wrong?.expected_value,
    });
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-2.5 text-[12px]" data-testid="field-verdict">
      <div className="text-ink-400">{col?.title ?? sel.fieldKey}</div>
      <div className="mt-0.5 font-semibold break-words text-ink-100">{hit.found ? (typeof hit.value === "string" ? hit.value || "（空）" : JSON.stringify(hit.value)) : "（模型输出里没有这个位置）"}</div>
      <dl className="mt-1.5 grid grid-cols-[64px_1fr] gap-x-1.5 gap-y-0.5 text-[11px]">
        <dt className="text-ink-400">字段状态</dt>
        <dd data-testid="field-state">{cell?.state ? <span title={cell.state}>{CELL_STATE_LABEL[cell.state]}</span> : "模型没有标注状态"}</dd>
        {converted && (
          <>
            <dt className="text-ink-400">表格显示</dt>
            <dd className="text-risk" data-testid="field-converted">
              {JSON.stringify(cell.value)}（系统整理成表格时做了转换，原始输出见上）
            </dd>
          </>
        )}
        <dt className="text-ink-400">实际输入</dt>
        <dd data-testid="field-input-coverage">
          {coverage.length ? (
            coverage.map((c) => (
              <div key={c.refId} className={cx(c.status === "NOT_SENT" && "text-stamp", c.status === "UNKNOWN" && "text-ink-400")}>
                {c.text}
              </div>
            ))
          ) : (
            <span className="text-risk">不可追溯：模型没有给出这个字段的来源</span>
          )}
        </dd>
      </dl>
      {parent?.found && (
        <details className="mt-1 text-[11px]" data-testid="field-raw-node">
          <summary className="cursor-pointer text-ink-400">原始输出中的所在节点</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-ink-700 bg-ink-950 p-1.5 font-mono text-[10.5px] whitespace-pre-wrap">
            {parentPointer}
            {"\n"}
            {(() => {
              const text = JSON.stringify(parent.value, null, 1);
              return text.length > 800 ? `${text.slice(0, 800)}…（已截断，完整内容见「原始输出」）` : text;
            })()}
          </pre>
        </details>
      )}
      <FieldDiagnoses diagnoses={(detail.diagnoses ?? []).filter((d) => d.target.json_pointer === p)} />
      <button
        onClick={copyDiagnosis}
        className="mt-1 text-[11px] text-ink-400 hover:text-info hover:underline"
        data-testid="btn-copy-diagnosis"
        title="复制后粘贴到已接入 MCP 的 Codex / Claude Code（见 docs/MCP接入说明.md），Agent 会按运行读取证据并给出带引用的诊断"
      >
        {copied ? "已复制" : "复制 Agent 诊断指令"}
      </button>
    </div>
  );
}

/** 结论没确认时补一句；归因本身就是「证据不足 / 无法归因」的不重复说 */
const diagSuffix = (status: string, category: string) => (status === "CONFIRMED" || category === "EVIDENCE_INSUFFICIENT" || category === "UNKNOWN" ? "" : "（未确认）");

/** Agent 提交的诊断：每条一行结论，依据与局限展开才显示；是推测，不改人工标注 */
function FieldDiagnoses({ diagnoses }: { diagnoses: NonNullable<RunDetail["diagnoses"]> }) {
  if (!diagnoses.length) return null;
  const list = (title: string, items: string[], mono = false) =>
    items.length > 0 && (
      <div className="mt-1">
        <div className="text-ink-400">{title}</div>
        <ul className={cx("list-disc pl-4", mono && "font-mono text-[10.5px] break-all")}>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="mt-1.5 border-t border-ink-800 pt-1.5 text-[11px]" data-testid="field-diagnoses">
      {diagnoses.map((d) => {
        const rc = d.report.root_cause;
        return (
          <details key={d.diagnosis_id} data-testid="field-diagnosis" data-status={d.result_status}>
            <summary className="cursor-pointer">
              <span className="text-ink-400" title="Agent 读取证据后的推测，未经人工核实；不会改动你的标注">
                AI 诊断
              </span>
              ：{categoryText(d.root_cause_category)}
              {diagSuffix(d.result_status, d.root_cause_category)}
              <span className="line-clamp-2"> {rc.summary}</span>
            </summary>
            <div className="mt-1 rounded border border-ink-800 bg-ink-950 p-1.5">
              <div>
                <span className="text-ink-400">结论：</span>
                {rc.summary}
              </div>
              <div className="mt-1">
                <span className="text-ink-400">建议：</span>
                {d.report.proposed_change.summary}
              </div>
              {list("已核实", d.report.verified_facts)}
              {list("依据", rc.supporting_evidence_refs, true)}
              {list("反证", rc.counter_evidence_refs, true)}
              {list("还没证实", rc.unverified_assumptions)}
              {list("局限", d.report.limitations)}
              <div className="mt-1 text-ink-400">
                {d.created_by} · {d.created_at.slice(0, 16).replace("T", " ")}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

const CELL_STATE_LABEL: Record<CellState, string> = {
  PRESENT: "有值",
  EXPLICIT_NONE: "明确无牌",
  SOURCE_BLANK: "原件空白",
  NOT_DETECTED: "未识别到",
  UNREADABLE: "无法辨认",
  AMBIGUOUS: "有歧义",
};

/** 全部类型的显示名（含旧数据里的"正确值""错误原因"，照常显示与导出） */
const ANN_LABEL: Record<string, string> = {
  ASSESSMENT: "评判",
  MODEL_WRONG: "模型错了",
  CORRECT_VALUE: "正确值",
  ERROR_REASON: "错误原因",
  CORRECT_CANDIDATE: "正确候选（P3）",
  WRONG_RELATION: "错误关系（P3）",
  NOTE: "备注",
  ...ISSUE_VERDICT_LABEL,
};
const ASSESS_LABEL = { WRONG: "标注错误", CORRECT: "标注正确", UNSURE: "暂不确定" } as const;
type Assess = keyof typeof ASSESS_LABEL;
/** 错误归因（v1.3 §6.2 的 13 类）；新标注只能选这些 */
const CATEGORY_LABEL: Record<string, string> = {
  INPUT_MISSING_PAGE: "输入缺页：相关页没有进入模型",
  PREPROCESSING_ERROR: "预处理：文字抽取 / 转图失真",
  OCR_VISION_ERROR: "看图识字：原件已发送但读错",
  PROMPT_RULE_ERROR: "提示词规则：规则缺失或优先级错误",
  MODEL_REASONING_ERROR: "模型判断：证据和规则都在但判断错",
  CANDIDATE_RECALL_ERROR: "候选召回：正确候选没进入 P3 输入",
  RELATION_SELECTION_ERROR: "关系裁决：候选已在输入中但 P3 选错",
  SCHEMA_CONTRACT_ERROR: "输出结构：回答的格式不符合约定",
  ADAPTER_MAPPING_ERROR: "显示映射：模型输出正确但显示错",
  BUSINESS_RULE_ERROR: "业务规则：九立规则本身有误",
  INCORRECT_GOLD: "标准答案有误",
  EVIDENCE_INSUFFICIENT: "证据不足，无法判断",
  UNKNOWN: "暂时无法归因",
};
/** v1.1 的旧归因：只用于显示已有标注 */
const LEGACY_CATEGORY_LABEL: Record<string, string> = {
  INPUT_PREPROCESSING: "输入预处理",
  MODEL_EXTRACTION: "模型识别",
  PROMPT_RULE: "提示词规则",
  CANDIDATE_RECALL: "候选召回",
  MATCH_JUDGEMENT: "匹配裁决",
  SCHEMA_CONTRACT: "输出结构",
  ADAPTER_RENDER: "显示映射",
  UNDETERMINED: "暂时无法归因",
};
const categoryText = (c: string) => CATEGORY_LABEL[c] ?? (LEGACY_CATEGORY_LABEL[c] ? `${LEGACY_CATEGORY_LABEL[c]}（旧分类）` : c);
const REVISION_ACTION = { CREATE: "新增", UPDATE: "修改", DELETE: "删除" } as const;
/** P3 才有候选 / 关系类型；其余只用「评判」（对 / 错 / 不确定） */
const annTypeChoices = (kind: string) => ["ASSESSMENT", ...(kind === "JIULI_P3" ? ["CORRECT_CANDIDATE", "WRONG_RELATION"] : [])];

/** 标注的修订历史：展开时才渲染旧版本内容，默认只显示修订次数 */
function RevisionHistory({ a }: { a: AnnotationDTO }) {
  const [open, setOpen] = useState(false);
  const revs = a.revisions ?? [];
  return (
    <details className="mt-0.5" data-testid="annotation-revisions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-[10.5px] text-ink-400">
        修订 {revs.length - 1} 次（第 {a.revision} 版）
      </summary>
      {open && (
        <ol className="ml-3 list-decimal text-[10.5px] text-ink-300">
          {revs.map((r) => (
            <li key={r.revision}>
              {REVISION_ACTION[r.action]} · {r.created_at.slice(0, 19).replace("T", " ")} · {r.author ?? "—"}：{r.body.assessment ? ASSESS_LABEL[r.body.assessment] : (ANN_LABEL[r.body.issue_type] ?? r.body.issue_type)}
              {r.body.error_category && ` · ${categoryText(r.body.error_category)}`}
              {r.body.expected_value && ` · 正确值 ${r.body.expected_value}`}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/**
 * 标注只有三个按钮：「✓ 对」直接保存；「✗ 错」「? 不确定」在原地展开正确值、错在哪、备注三个框。
 * 标注独立保存，不修改模型输出、九立池或原始附件。children（来源证据）显示在按钮与已有标注之间。
 */
function AnnotationForm({ detail, children }: { detail: RunDetail; children?: React.ReactNode }) {
  const sel = useStudio((s) => s.selection);
  const putRun = useStudio((s) => s.putRun);
  const select = useStudio((s) => s.select);
  const [type, setType] = useState("ASSESSMENT");
  /** 展开区对应的评判；null = 收起 */
  const [assess, setAssess] = useState<Assess | null>(null);
  const [category, setCategory] = useState("");
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在修改的标注；为空时用于新增 */
  const [editing, setEditing] = useState<AnnotationDTO | null>(null);
  const [saved, setSaved] = useState(false);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const choices = annTypeChoices(detail.run.prompt_kind);
  // 修改旧标注时保留它原来的类型
  if (editing && !choices.includes(editing.issue_type)) choices.push(editing.issue_type);
  const target = [sel.tableId, sel.rowId, sel.fieldKey].filter(Boolean).join(" / ") || sel.relationId || null;
  /** 标注的「目标」显示：字段 key 换成该列的中文名（找不到列就原样）；原始串放 title */
  const targetText = (raw: string | null | undefined) => {
    const parts = raw?.split(" / ") ?? [];
    const col = parts.length === 3 ? detail.run.view_model?.tables.find((t) => t.id === parts[0])?.columns.find((c) => c.key === parts[2]) : undefined;
    return col ? `${parts[0]} / ${parts[1]} / ${col.title}` : raw;
  };
  const assessing = type === "ASSESSMENT";
  const done = detail.annotations.find((a) => a.target_json_pointer === sel.jsonPointer && a.assessment === "CORRECT");
  const needCategory = assessing && assess === "WRONG" && !category;

  // 换了选中位置就收起新增表单（修改中的不动）
  useEffect(() => {
    if (!editing) setAssess(null);
  }, [sel.jsonPointer]); // eslint-disable-line react-hooks/exhaustive-deps
  // 点「错」后直接把光标放到「错在哪」
  useEffect(() => {
    if (assess === "WRONG") categoryRef.current?.focus();
  }, [assess]);

  function reset() {
    setEditing(null);
    setType("ASSESSMENT");
    setAssess(null);
    setCategory("");
    setExpected("");
    setNote("");
  }

  async function markCorrect() {
    setErr(null);
    setBusy(true);
    try {
      const a = await api<AnnotationDTO>(`/api/runs/${detail.run.run_id}/annotations`, {
        json: { issue_type: "ASSESSMENT", assessment: "CORRECT", error_category: null, category_confirmed: null, target_json_pointer: sel.jsonPointer, target, source_ref_ids: sel.sourceRefId ? [sel.sourceRefId] : [] },
      });
      putRun({ ...detail, annotations: [...detail.annotations, a] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setErr(null);
    const judgement = assessing ? { assessment: assess, error_category: assess === "CORRECT" ? null : category || null, category_confirmed: null } : {};
    try {
      if (editing) {
        const a = await api<AnnotationDTO>(`/api/annotations/${editing.annotation_id}`, { method: "PATCH", json: { issue_type: type, expected_value: expected, note, ...judgement } });
        putRun({ ...detail, annotations: detail.annotations.map((x) => (x.annotation_id === a.annotation_id ? a : x)) });
      } else {
        const a = await api<AnnotationDTO>(`/api/runs/${detail.run.run_id}/annotations`, {
          json: { issue_type: type, expected_value: expected || undefined, note: note || undefined, target_json_pointer: sel.jsonPointer, target, source_ref_ids: sel.sourceRefId ? [sel.sourceRefId] : [], ...judgement },
        });
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
    setAssess(a.assessment ?? "WRONG");
    setCategory(a.error_category ?? "");
    setExpected(a.expected_value ?? "");
    setNote(a.note ?? "");
  }

  /** 问题的属实 / 误报没有展开表单：选中那条问题，抽屉顶部的两个按钮就是修改入口 */
  function editIssueVerdict(a: AnnotationDTO) {
    const issue = detail.run.view_model?.issues.find((i) => i.id === issueIdOfTarget(a.target));
    if (issue) select({ issueId: issue.id, tableId: issue.target?.tableId, rowId: issue.target?.rowId, fieldKey: issue.target?.fieldKey, jsonPointer: issue.target?.jsonPointer, sourceRefId: issue.sourceRefIds[0] });
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

  const open = assess !== null;
  return (
    <div className="space-y-3" data-testid="annotation-form">
      {(sel.jsonPointer || editing) && (
        <div className="space-y-1.5">
          {editing && <div className="text-[11px] text-info" title={editing.target ?? editing.target_json_pointer ?? undefined}>正在修改：{targetText(editing.target ?? editing.target_json_pointer) ?? "整个运行"}</div>}
          {(!editing || assessing) && (
            <div className="flex gap-1.5">
              {/* 新增时「对」直接保存；修改时三个按钮用来改评判 */}
              <Btn tone="outline" onClick={editing ? () => setAssess("CORRECT") : markCorrect} disabled={busy || (!editing && !!done)} aria-pressed={!!editing && assess === "CORRECT"} data-testid="btn-mark-correct" className={cx(editing && assess === "CORRECT" && "border-verify text-verify")}>
                {!editing && done ? "✓ 已标为正确" : "✓ 对"}
              </Btn>
              <Btn tone="outline" onClick={() => setAssess("WRONG")} aria-pressed={assess === "WRONG"} data-testid="btn-mark-wrong" className={cx(assess === "WRONG" && "border-stamp text-stamp")}>
                ✗ 错
              </Btn>
              <Btn tone="outline" onClick={() => setAssess("UNSURE")} aria-pressed={assess === "UNSURE"} data-testid="btn-mark-unsure" className={cx(assess === "UNSURE" && "border-risk text-risk")}>
                ? 不确定
              </Btn>
            </div>
          )}
          {(open || (editing && !assessing)) && (
            <div className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-900 p-2">
              {choices.length > 1 && (
                <select value={type} onChange={(e) => setType(e.target.value)} aria-label="标注类型" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-1 py-0.5 text-[12px]">
                  {choices.map((v) => (
                    <option key={v} value={v}>
                      {ANN_LABEL[v] ?? v}
                    </option>
                  ))}
                </select>
              )}
              <input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="正确值（可选）" aria-label="正确值" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5 text-[12px]" />
              {assessing && assess !== "CORRECT" && (
                <select ref={categoryRef} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="错误归因" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-1 py-0.5 text-[12px]">
                  <option value="">{assess === "WRONG" ? "错在哪？（必选）" : "错在哪？（可选）"}</option>
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                  {category && !CATEGORY_LABEL[category] && <option value={category}>{categoryText(category)}</option>}
                </select>
              )}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选）" aria-label="标注备注" rows={2} className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5 text-[12px]" />
              <div className="flex gap-1">
                <Btn tone="outline" onClick={save} disabled={needCategory} title={needCategory ? "请先选「错在哪」" : undefined}>
                  {editing ? "保存修改" : "保存标注"}
                </Btn>
                <Btn onClick={reset}>取消</Btn>
              </div>
            </div>
          )}
          {saved && (
            <span className="text-[11px] text-verify" role="status">
              已保存
            </span>
          )}
          {err && <p className="text-[11px] text-stamp">{err}</p>}
        </div>
      )}
      {children}
      <div>
        <h4 className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-ink-300">
          已有标注（{detail.annotations.length}）
          <span className="ml-auto font-normal">
            导出：
            <a href={`/api/annotations/export?project=${detail.run.project_id}&format=csv`} className="text-info hover:underline" data-testid="export-annotations-csv">
              CSV
            </a>
            {" / "}
            <a href={`/api/annotations/export?project=${detail.run.project_id}&format=json`} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">
              JSON
            </a>
          </span>
        </h4>
        {detail.annotations.length > 0 && (
          <ul className="space-y-1">
            {detail.annotations.map((a) => (
              <li key={a.annotation_id} className={cx("rounded-lg bg-ink-800 px-2 py-1 text-[11px]", editing?.annotation_id === a.annotation_id && "ring-1 ring-info")}>
                <div className="flex items-center gap-1">
                  <Badge tone={a.assessment === "WRONG" ? "bad" : a.assessment === "CORRECT" ? "ok" : a.assessment === "UNSURE" ? "warn" : "info"}>{a.assessment ? ASSESS_LABEL[a.assessment] : (ANN_LABEL[a.issue_type] ?? a.issue_type)}</Badge>{" "}
                  <span className="min-w-0 flex-1 truncate text-ink-400" title={a.target ?? a.target_json_pointer ?? undefined}>
                    {a.issue_type in ISSUE_VERDICT_LABEL ? `问题：${issueSummaryOfTarget(a.target).slice(0, 20)} — ${ISSUE_VERDICT_LABEL[a.issue_type]}` : targetText(a.target ?? a.target_json_pointer)}
                  </span>
                  <button onClick={() => (a.issue_type in ISSUE_VERDICT_LABEL ? editIssueVerdict(a) : startEdit(a))} className="text-info hover:underline" aria-label={`修改标注 ${a.annotation_id}`}>
                    修改
                  </button>
                  <button onClick={() => remove(a)} className="text-stamp hover:underline" aria-label={`删除标注 ${a.annotation_id}`}>
                    删除
                  </button>
                </div>
                {a.error_category && <div>错在：{categoryText(a.error_category)}</div>}
                {a.model_value != null && <div className="text-ink-400">模型原值：{a.model_value}</div>}
                {a.expected_value && <div>正确值：{a.expected_value}</div>}
                {a.note && <div className="text-ink-300">{a.note}</div>}
                {a.author && <div className="text-[10px] text-ink-600">{a.author} · {a.created_at.slice(0, 19).replace("T", " ")}</div>}
                {(a.revisions?.length ?? 0) > 1 && <RevisionHistory a={a} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
