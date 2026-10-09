"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import type { AnnotationDTO, RunDetail } from "@/lib/client/types";
import type { ViewModel } from "@/lib/contracts/view-model";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { useStudio, type ResultTab } from "@/lib/state/studio-store";
import { EvidenceViewer } from "@/components/renderers/evidence-viewer";
import { BusinessView } from "@/components/views/business-view";
import { Badge, Btn, cx, Empty, RUN_STATUS_LABEL, RUN_STATUS_TONE } from "@/components/ui";
import { JsonTree, RawText } from "./json-tree";

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
        "rise border-b px-3 py-1.5 text-[12px]",
        tone === "warn" && "border-risk/30 bg-risk/10 text-risk",
        tone === "bad" && "border-stamp/40 bg-stamp/10 text-stamp",
        tone === "info" && "border-info/30 bg-info/10 text-info",
      )}
    >
      {children}
    </div>
  );
}

export function ResultPane({ detail, dirty, canPreview, loading }: { detail?: RunDetail; dirty: boolean; canPreview: boolean; loading: boolean }) {
  const tab = useStudio((s) => s.resultTab);
  const setStore = useStudio((s) => s.set);
  const maximized = useStudio((s) => s.maximized);
  const evidenceOpen = useStudio((s) => s.evidenceOpen);
  const run = detail?.run;
  const vm = run?.view_model ?? undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="result-pane">
      <div className="flex items-center gap-1 border-b border-ink-700 bg-ink-900 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setStore("resultTab", t.id)}
            className={cx("relative px-3 py-2 text-[12.5px]", tab === t.id ? "text-ink-100" : "text-ink-400 hover:text-ink-100")}
          >
            {t.label}
            {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 bg-stamp" />}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {run && (
            <>
              <Badge tone="mute">{run.mode}</Badge>
              <Badge tone={RUN_STATUS_TONE[run.status]} title={run.status}>
                {RUN_STATUS_LABEL[run.status] ?? run.status}
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

      {dirty && run && <Banner tone="warn">当前结果来自上次运行（与未保存/未运行的编辑不同）。</Banner>}
      {run?.status === "PARSE_ERROR" && <Banner tone="bad">原始回复不是合法 JSON：不生成任何业务表格。请在「原始 JSON」查看原文与错误位置。</Banner>}
      {run?.status === "SCHEMA_INVALID" && <Banner tone="warn">JSON 合法但 Schema 校验未通过（SCHEMA_INVALID）：下方为可安全理解部分的局部渲染，非完整结果。</Banner>}
      {run?.status === "ADAPTER_ERROR" && <Banner tone="bad">适配器异常（ADAPTER_ERROR）：已保留原始 JSON 与校验结果，详见「结构校验」。</Banner>}
      {run?.status === "MODEL_ERROR" && (
        <Banner tone="bad">
          模型调用失败：{run.error?.code} — {run.error?.message}（已保存失败 Run，未回退为 Mock 结果）
        </Banner>
      )}
      {run && !vm && run.status === "SUCCEEDED" && <Banner tone="info">未登记 Schema（UNKNOWN_SCHEMA）：不套用九立模板，请在「原始 JSON」查看 JSON 树，或选择正确的 Prompt/Schema。</Banner>}
      {run?.rerender_note && <Banner tone="info">{run.rerender_note}（原始结果 Hash 未变：{run.raw_response_hash.slice(0, 12)}…）</Banner>}

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3" data-testid={`tab-${tab}`}>
        {loading && <p className="text-ink-400">处理中…</p>}
        {!run && !loading && <Empty>选择样本并点「仅渲染」，或配置模型后「运行」。</Empty>}
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
            {vm ? <EvidenceViewer vm={vm} canPreview={canPreview} /> : <p className="text-[12px] text-ink-400">无业务视图，无法定位来源。</p>}
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
    <div className="rounded border border-ink-700 p-2 text-[11px] text-ink-300">
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
        <div className="flex overflow-hidden rounded border border-ink-600 text-[11px]">
          <button onClick={() => setDoc("response")} className={cx("px-2 py-0.5", doc === "response" ? "bg-ink-700" : "text-ink-400")}>
            模型原始响应
          </button>
          <button onClick={() => setDoc("request")} disabled={!detail.request} className={cx("px-2 py-0.5 disabled:opacity-40", doc === "request" ? "bg-ink-700" : "text-ink-400")}>
            请求上下文（快照）
          </button>
        </div>
        <Btn onClick={() => navigator.clipboard?.writeText(run.raw_response)}>复制原文</Btn>
        <span className="font-mono text-[11px] text-ink-400">sha256 {run.raw_response_hash.slice(0, 16)}…</span>
      </div>
      {!found && <p className="rounded border border-risk/40 bg-risk/10 px-2 py-1 text-[12px] text-risk">无法定位：{pointer} 在当前文档中不存在。</p>}
      {sel.jsonPointer !== undefined && pointer === undefined && <p className="text-[12px] text-ink-400">所选对象位于{isReq ? "请求上下文" : "模型响应"}，请切换文档查看。</p>}
      <div className="rounded border border-ink-700 bg-ink-950/70 p-2">
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
      <dt className="text-ink-400">{k}</dt>
      <dd className="font-mono break-all">{v ?? <span className="text-ink-600">unknown</span>}</dd>
    </>
  );
}

function MetaTab({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  const [showPrompt, setShow] = useState(false);
  return (
    <div className="space-y-3 text-[12px]">
      <dl className="grid grid-cols-[180px_1fr] gap-x-3 gap-y-1">
        <Row k="run_id" v={r.run_id} />
        <Row k="模式 / 状态" v={`${r.mode} / ${r.status}`} />
        <Row k="标签" v={r.label} />
        <Row k="Prompt / 种类" v={`${r.prompt_id} / ${r.prompt_kind}`} />
        <Row k="Prompt 版本" v={r.prompt_version_id ? `${r.prompt_version_id}${r.is_unsaved_draft ? "（运行时为未保存草稿）" : ""}` : r.mode === "RENDER_ONLY" ? "不适用（仅渲染）" : "未保存草稿"} />
        <Row k="实际提示词 Hash" v={r.actual_prompt_hash} />
        <Row k="构造输入 Hash" v={r.built_input_hash} />
        <Row k="输入构造器" v={r.input_builder_id} />
        <Row k="输入快照" v={detail.snapshot ? `${detail.snapshot.label}（${detail.snapshot.snapshot_id}，${detail.snapshot.source_type}，hash ${detail.snapshot.content_hash.slice(0, 12)}…）` : "无"} />
        <Row k="模型" v={r.model_provider ? `${r.model_provider} · ${r.model_name}` : "未调用模型"} />
        <Row k="Provider 适配器版本" v={r.provider_adapter_version} />
        <Row k="模型参数" v={r.model_params ? JSON.stringify(r.model_params) : null} />
        <Row k="附带原件图片" v={r.attached_images ? (r.attached_images.length ? r.attached_images.map((i) => `${i.file_id}${i.page ? ` 第${i.page}页` : ""}`).join("，") : "已开启，但没有可附带的图片") : null} />
        <Row k="Schema" v={r.schema_id ? `${r.schema_id} (${r.schema_version})` : null} />
        <Row k="Adapter" v={r.adapter_id ? `${r.adapter_id}@${r.adapter_version}` : null} />
        <Row k="RendererConfig 版本" v={r.renderer_config_version} />
        <Row k="开始 / 结束" v={`${r.started_at} → ${r.ended_at ?? "—"}`} />
        <Row k="耗时" v={r.latency_ms != null ? `${r.latency_ms} ms` : null} />
        <Row k="Token" v={r.token_usage ? JSON.stringify(r.token_usage) : null} />
        <Row k="费用" v={r.estimated_cost ? `${r.estimated_cost.value} ${r.estimated_cost.currency}（${r.estimated_cost.basis}）` : null} />
        <Row k="原始响应 sha256" v={r.raw_response_hash} />
        <Row k="回放来源" v={r.replay_of_run_id} />
        <Row k="错误" v={r.error ? `${r.error.code}: ${r.error.message}` : "无"} />
      </dl>
      {detail.snapshot?.warnings?.length ? (
        <div className="rounded border border-risk/30 p-2 text-[11.5px] text-risk">
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
            <pre className="mt-2 max-h-96 overflow-auto rounded border border-ink-700 bg-ink-950 p-2 text-[11px] whitespace-pre-wrap">
              {`# system\n${r.actual_prompt.system}\n\n# user\n${r.actual_prompt.user}`}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const ANN_TYPES: [string, string][] = [
  ["MODEL_WRONG", "模型错了"],
  ["CORRECT_VALUE", "正确值"],
  ["ERROR_REASON", "错误原因"],
  ["CORRECT_CANDIDATE", "正确候选（P3）"],
  ["WRONG_RELATION", "错误关系（P3）"],
  ["NOTE", "备注"],
];

/** 纠错标注独立保存，不修改模型输出、九立池或原始附件 */
function AnnotationForm({ detail }: { detail: RunDetail }) {
  const sel = useStudio((s) => s.selection);
  const putRun = useStudio((s) => s.putRun);
  const [type, setType] = useState("MODEL_WRONG");
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const target = [sel.tableId, sel.rowId, sel.fieldKey].filter(Boolean).join(" / ") || sel.relationId || null;

  async function save() {
    setErr(null);
    try {
      const a = await api<AnnotationDTO>(`/api/runs/${detail.run.run_id}/annotations`, { json: { issue_type: type, expected_value: expected || undefined, note: note || undefined, target_json_pointer: sel.jsonPointer, target } });
      putRun({ ...detail, annotations: [...detail.annotations, a] });
      setExpected("");
      setNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="border-t border-ink-700 pt-2" data-testid="annotation-form">
      <h4 className="mb-1 text-[11.5px] font-semibold text-ink-300">评测标注（独立保存，不改模型输出）</h4>
      <div className="space-y-1.5">
        <div className="text-[11px] text-ink-400">目标：{target ?? "（未选择，标注整个 Run）"}</div>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="标注类型" className="w-full rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-[12px]">
          {ANN_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="正确值（可选）" aria-label="正确值" className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-[12px]" />
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="错误原因 / 备注" aria-label="标注备注" rows={2} className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-[12px]" />
        <Btn tone="outline" onClick={save}>
          保存标注
        </Btn>
        {err && <p className="text-[11px] text-stamp">{err}</p>}
      </div>
      {detail.annotations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {detail.annotations.map((a) => (
            <li key={a.annotation_id} className="rounded bg-ink-800 px-2 py-1 text-[11px]">
              <Badge tone="info">{ANN_TYPES.find(([v]) => v === a.issue_type)?.[1] ?? a.issue_type}</Badge> <span className="text-ink-400">{a.target ?? a.target_json_pointer}</span>
              {a.expected_value && <div>正确值：{a.expected_value}</div>}
              {a.note && <div className="text-ink-300">{a.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
