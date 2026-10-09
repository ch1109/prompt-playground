"use client";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CapabilityDTO, FixtureSummary, PromptVersionDTO, ProviderInfoDTO, SnapshotListItem } from "@/lib/client/types";
import type { PromptKind } from "@/lib/contracts/run";
import { useWorkspace, type InputMode } from "@/lib/state/studio-store";
import { Badge, Btn, cx, Empty } from "@/components/ui";

type EditorTab = "prompt" | "input" | "model" | "preview";

const ORIGIN_TONE = { STRUCTURE_EXAMPLE: "mute", RECORDED_MODEL_OUTPUT: "info", CONSTRUCTED: "warn" } as const;
const ORIGIN_SHORT = { STRUCTURE_EXAMPLE: "结构示例", RECORDED_MODEL_OUTPUT: "真实录制·非Gold", CONSTRUCTED: "人工构造" } as const;

export function EditorPane(props: {
  kind: PromptKind;
  versions: PromptVersionDTO[];
  fixtures: FixtureSummary[];
  snapshots: SnapshotListItem[];
  provider: ProviderInfoDTO | null;
  capability: CapabilityDTO | null;
  onSaveVersion: (label: string) => Promise<void>;
  onSnapshotsChanged: () => void;
}) {
  const [tab, setTab] = useState<EditorTab>("input");
  const [ws, patch] = useWorkspace();
  const version = props.versions.find((v) => v.version_id === ws.versionId);
  const isDraft = !version || version.system_prompt !== ws.system || version.user_prompt_template !== ws.userTemplate;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-pane">
      <div className="flex items-center gap-1 border-b border-ink-700 bg-ink-900 px-2">
        {(
          [
            ["input", "输入"],
            ["prompt", "提示词"],
            ["model", "模型"],
            ["preview", "请求预览"],
          ] as [EditorTab, string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={cx("relative px-3 py-2 text-[12.5px]", tab === id ? "text-ink-100" : "text-ink-400 hover:text-ink-100")}>
            {label}
            {id === "prompt" && isDraft && <span className="ml-1 text-risk">●</span>}
            {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 bg-stamp" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "prompt" && <PromptTab versions={props.versions} isDraft={isDraft} onSave={props.onSaveVersion} />}
        {tab === "input" && <InputTab kind={props.kind} fixtures={props.fixtures} snapshots={props.snapshots} capability={props.capability} onSnapshotsChanged={props.onSnapshotsChanged} />}
        {tab === "model" && <ModelTab provider={props.provider} />}
        {tab === "preview" && <PreviewTab />}
      </div>
      <div className="border-t border-ink-700 px-3 py-1 text-[11px] text-ink-400">
        输入：{ws.inputMode === "fixture" ? `样本 ${ws.fixtureId ?? "未选"}` : ws.inputMode === "paste" ? "粘贴 JSON" : `快照 ${ws.snapshotId ?? "未选"}`}
      </div>
    </div>
  );
}

function PromptTab({ versions, isDraft, onSave }: { versions: PromptVersionDTO[]; isDraft: boolean; onSave: (label: string) => Promise<void> }) {
  const [ws, patch] = useWorkspace();
  const [label, setLabel] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={ws.versionId ?? ""}
          onChange={(e) => {
            const v = versions.find((x) => x.version_id === e.target.value);
            if (v) patch({ versionId: v.version_id, versionHash: v.content_hash, system: v.system_prompt, userTemplate: v.user_prompt_template });
          }}
          aria-label="Prompt 版本"
          className="flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]"
        >
          {versions.map((v) => (
            <option key={v.version_id} value={v.version_id}>
              {v.label} · {v.created_at.slice(0, 16).replace("T", " ")}
            </option>
          ))}
        </select>
        {isDraft ? <Badge tone="warn">未保存草稿</Badge> : <Badge tone="ok">与版本一致</Badge>}
      </div>
      <label className="block text-[11px] text-ink-400">System（提示词正文）</label>
      <textarea
        value={ws.system}
        onChange={(e) => patch({ system: e.target.value })}
        aria-label="System 提示词"
        spellCheck={false}
        className="h-[38vh] w-full resize-y rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[12px] leading-5 outline-none focus:border-ink-400"
      />
      <label className="block text-[11px] text-ink-400">
        User 模板（变量 <code className="text-info">{"{{input_json}}"}</code> = 由快照显式构造的请求 JSON）
      </label>
      <textarea
        value={ws.userTemplate}
        onChange={(e) => patch({ userTemplate: e.target.value })}
        aria-label="User 模板"
        spellCheck={false}
        className="h-24 w-full resize-y rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[12px] outline-none focus:border-ink-400"
      />
      <div className="flex items-center gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="新版本名称" aria-label="新版本名称" className="flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]" />
        <Btn
          tone="outline"
          disabled={!isDraft}
          onClick={async () => {
            await onSave(label || `草稿 ${new Date().toLocaleString("zh-CN")}`);
            setLabel("");
          }}
        >
          保存为新版本
        </Btn>
      </div>
      <p className="text-[11px] text-ink-400">版本只新增不覆盖；未保存也可运行，Run 会记录 is_unsaved_draft 与实际发送内容 Hash。</p>
    </div>
  );
}

function InputTab({ kind, fixtures, snapshots, capability, onSnapshotsChanged }: { kind: PromptKind; fixtures: FixtureSummary[]; snapshots: SnapshotListItem[]; capability: CapabilityDTO | null; onSnapshotsChanged: () => void }) {
  const [ws, patch] = useWorkspace();
  const modes: [InputMode, string][] = [
    ["fixture", "样本库"],
    ["paste", "粘贴 / 文件 JSON"],
    ["snapshot", "已有快照"],
    ["jiuli", "从九立导入"],
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap overflow-hidden rounded border border-ink-600 text-[12px]">
        {modes.map(([m, l]) => (
          <button key={m} onClick={() => patch({ inputMode: m })} className={cx("flex-1 px-2 py-1", ws.inputMode === m ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-100")}>
            {l}
          </button>
        ))}
      </div>
      {ws.inputMode === "fixture" && <FixtureList kind={kind} fixtures={fixtures} />}
      {ws.inputMode === "paste" && <PasteInput />}
      {ws.inputMode === "snapshot" && <SnapshotList snapshots={snapshots} />}
      {ws.inputMode === "jiuli" && <JiuliImport capability={capability} onCreated={onSnapshotsChanged} />}
    </div>
  );
}

function FixtureList({ kind, fixtures }: { kind: PromptKind; fixtures: FixtureSummary[] }) {
  const [ws, patch] = useWorkspace();
  const list = fixtures.filter((f) => f.promptKind === kind);
  const groups = useMemo(() => [...new Set(list.map((f) => f.group))], [list]);
  if (!list.length) return <Empty>当前 Prompt 没有样本。</Empty>;
  return (
    <div className="space-y-2" data-testid="fixture-list">
      <p className="text-[11px] text-ink-400">样本来源已标注：规格结构示例 / 真实录制模型输出（非 Gold）/ 人工构造。均不能用于宣称准确率。</p>
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-0.5 text-[11px] font-semibold text-ink-400">{g}</div>
          <ul className="space-y-px">
            {list
              .filter((f) => f.group === g)
              .map((f) => (
                <li key={f.id}>
                  <button
                    data-fixture-id={f.id}
                    onClick={() => patch({ fixtureId: f.id })}
                    className={cx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-ink-800", ws.fixtureId === f.id && "bg-stamp/10 ring-1 ring-stamp/50")}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    {f.hasRequest && <Badge title="带请求上下文（可解析 evidence_key / 当前值）">ctx</Badge>}
                    {f.covers?.length ? <Badge tone="mute">{f.covers.join(" ")}</Badge> : null}
                    <Badge tone={ORIGIN_TONE[f.origin]}>{ORIGIN_SHORT[f.origin]}</Badge>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PasteInput() {
  const [ws, patch] = useWorkspace();
  const readFile = (f: File, key: "pasteRaw" | "pasteRequest") => f.text().then((t) => patch({ [key]: t }));
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-400">模型原始输出（原样保存，不做任何修改）</label>
      <textarea value={ws.pasteRaw} onChange={(e) => patch({ pasteRaw: e.target.value })} aria-label="原始输出" spellCheck={false} placeholder='{"schema_version":"jiuli-ai-v3", ...}' className="h-56 w-full rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[12px] outline-none focus:border-ink-400" />
      <input type="file" accept=".json,.txt" aria-label="上传原始输出文件" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], "pasteRaw")} className="text-[11px] text-ink-400" />
      <label className="block text-[11px] text-ink-400">请求上下文 JSON（可选，v3 P3/P4 用于解析 evidence_key、当前值）</label>
      <textarea value={ws.pasteRequest} onChange={(e) => patch({ pasteRequest: e.target.value })} aria-label="请求上下文" spellCheck={false} className="h-28 w-full rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[12px] outline-none focus:border-ink-400" />
      <input type="file" accept=".json" aria-label="上传请求上下文文件" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], "pasteRequest")} className="text-[11px] text-ink-400" />
    </div>
  );
}

function SnapshotList({ snapshots }: { snapshots: SnapshotListItem[] }) {
  const [ws, patch] = useWorkspace();
  if (!snapshots.length) return <Empty>还没有快照。可从样本、JSON 或九立只读导入创建。</Empty>;
  return (
    <ul className="space-y-px" data-testid="snapshot-list">
      {snapshots.map((s) => (
        <li key={s.snapshot_id}>
          <button onClick={() => patch({ snapshotId: s.snapshot_id })} className={cx("w-full rounded px-2 py-1 text-left text-[12px] hover:bg-ink-800", ws.snapshotId === s.snapshot_id && "bg-stamp/10 ring-1 ring-stamp/50")}>
            <div className="flex items-center gap-2">
              <Badge tone={s.source_type === "JIULI_READONLY" ? "info" : "mute"}>{s.source_type}</Badge>
              <span className="truncate">{s.label}</span>
            </div>
            <div className="font-mono text-[10.5px] text-ink-400">
              {s.snapshot_id} · {s.imported_at.slice(0, 19).replace("T", " ")} · hash {s.content_hash.slice(0, 10)}
              {s.parent_snapshot_id && ` · 刷新自 ${s.parent_snapshot_id}`}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface Customer {
  customer_id: string;
  name: string;
}
interface Task {
  task_id: string;
  sample_id?: string;
  line_count: number;
  status?: string;
}
interface Batch {
  batch_id: string;
  warehouse_no?: string;
  line_count: number;
}

/** 九立只读导入：选客户 → 任务/查货批次 → 创建 Studio 隔离快照。不向九立写任何数据。 */
function JiuliImport({ capability, onCreated }: { capability: CapabilityDTO | null; onCreated: () => void }) {
  const [, patch] = useWorkspace();
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [task, setTask] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = capability?.status === "CONNECTED_DEMO_FILES";

  useEffect(() => {
    if (!connected) return;
    api<{ items: Customer[] }>(`/api/connectors/jiuli/customers?q=${encodeURIComponent(q)}`)
      .then((r) => setCustomers(r.items))
      .catch((e) => setErr(e.message));
  }, [q, connected]);

  useEffect(() => {
    if (!customer) return;
    setTask("");
    setPicked(new Set());
    Promise.all([api<{ items: Task[] }>(`/api/connectors/jiuli/tasks?customerId=${customer}`), api<{ items: Batch[] }>(`/api/connectors/jiuli/inspections?customerId=${customer}`)])
      .then(([t, b]) => {
        setTasks(t.items);
        setBatches(b.items);
      })
      .catch((e) => setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)));
  }, [customer]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<{ snapshot_id: string; warnings: string[] }>("/api/connectors/jiuli/snapshots", { json: { customerId: customer, taskId: task || undefined, batchIds: [...picked] } });
      patch({ inputMode: "snapshot", snapshotId: s.snapshot_id });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="jiuli-import">
      <div className={cx("rounded border p-2 text-[12px]", connected ? "border-verify/40 bg-verify/5" : "border-risk/40 bg-risk/10")}>
        <div className="flex items-center gap-2">
          <Badge tone={connected ? "ok" : "warn"}>{capability?.status ?? "检测中"}</Badge>
          <Badge tone="mute">只读</Badge>
          {capability && !capability.realApi && <Badge tone="warn">真实九立 API 未接通</Badge>}
        </div>
        <p className="mt-1 text-ink-300">{capability?.message}</p>
        {capability?.source && <p className="font-mono text-[10.5px] text-ink-400">{capability.source}</p>}
      </div>
      {connected && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索客户（仅显示已授权客户）" aria-label="搜索客户" className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]" />
          <ul className="max-h-36 overflow-auto rounded border border-ink-800">
            {customers.map((c) => (
              <li key={c.customer_id}>
                <button onClick={() => setCustomer(c.customer_id)} className={cx("w-full px-2 py-1 text-left text-[12px] hover:bg-ink-800", customer === c.customer_id && "bg-stamp/10")}>
                  {c.name} <span className="font-mono text-[10.5px] text-ink-400">{c.customer_id}</span>
                </button>
              </li>
            ))}
          </ul>
          {customer && (
            <>
              <label className="block text-[11px] text-ink-400">委托任务</label>
              <select value={task} onChange={(e) => setTask(e.target.value)} aria-label="委托任务" className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]">
                <option value="">（不选任务）</option>
                {tasks.map((t) => (
                  <option key={t.task_id} value={t.task_id}>
                    {t.task_id} · {t.sample_id} · {t.line_count} 行 · {t.status}
                  </option>
                ))}
              </select>
              <label className="block text-[11px] text-ink-400">查货批次（可多选）</label>
              <ul className="max-h-36 overflow-auto rounded border border-ink-800">
                {batches.map((b) => (
                  <li key={b.batch_id} className="flex items-center gap-2 px-2 py-0.5 text-[12px]">
                    <input
                      type="checkbox"
                      checked={picked.has(b.batch_id)}
                      onChange={(e) => setPicked((s) => (e.target.checked ? new Set([...s, b.batch_id]) : new Set([...s].filter((x) => x !== b.batch_id))))}
                      aria-label={`选择批次 ${b.batch_id}`}
                    />
                    <span className="font-mono">{b.warehouse_no ?? "（无入仓号）"}</span>
                    <span className="text-ink-400">{b.line_count} 行</span>
                  </li>
                ))}
              </ul>
              <Btn tone="primary" disabled={busy || (!task && !picked.size)} onClick={create}>
                {busy ? "读取中…" : "只读读取并创建隔离快照"}
              </Btn>
            </>
          )}
        </>
      )}
      {err && <p className="text-[12px] text-stamp">{err}</p>}
      <p className="text-[11px] text-ink-400">运行时不会再隐式拉取新数据；需要更新时重新导入，生成新快照，旧快照与旧 Run 保留。</p>
    </div>
  );
}

function ModelTab({ provider }: { provider: ProviderInfoDTO | null }) {
  const [ws, patch] = useWorkspace();
  return (
    <div className="space-y-3 text-[12px]">
      <div className={cx("rounded border p-2", provider?.configured ? "border-verify/40" : "border-risk/40 bg-risk/10")}>
        <div className="flex items-center gap-2">
          <Badge tone={provider?.configured ? "ok" : "warn"}>{provider?.configured ? "已配置" : "未配置"}</Badge>
          <span className="font-mono">{provider?.provider}</span>
          <span className="font-mono text-ink-300">{provider?.model || "—"}</span>
        </div>
        <p className="mt-1 text-ink-400">
          {provider?.configured
            ? `点击运行后，提示词与构造输入将发送到 ${provider.provider}。API Key 只在服务端使用。`
            : "在项目根目录 .env.local 填写 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY 后重启。未配置时只能「仅渲染」。"}
        </p>
        <p className="text-ink-400">文件直传：{provider?.supportsFileInput ? "支持" : "不支持（只发送预处理文本；缺文本的材料会被阻断）"}</p>
      </div>
      <label className="flex items-center gap-2">
        <span className="w-28 text-ink-400">temperature</span>
        <input type="number" step="0.1" min={0} max={2} value={ws.params.temperature} onChange={(e) => patch({ params: { ...ws.params, temperature: Number(e.target.value) } })} aria-label="temperature" className="w-24 rounded border border-ink-700 bg-ink-950 px-2 py-0.5" />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-ink-400">max_tokens</span>
        <input type="number" step="1000" min={1} value={ws.params.max_tokens} onChange={(e) => patch({ params: { ...ws.params, max_tokens: Number(e.target.value) } })} aria-label="max_tokens" className="w-24 rounded border border-ink-700 bg-ink-950 px-2 py-0.5" />
      </label>
    </div>
  );
}

interface PreviewDTO {
  ok: boolean;
  code?: string;
  message?: string;
  builderId?: string;
  warnings?: string[];
  requiresFiles?: string[];
  system?: string;
  user?: string;
  actualPromptHash?: string;
  builtInputHash?: string;
  provider: ProviderInfoDTO;
}

function PreviewTab() {
  const [ws, , promptId] = useWorkspace();
  const [p, setP] = useState<PreviewDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!ws.snapshotId) return;
    api<PreviewDTO>("/api/runs/preview", { json: { promptId, snapshotId: ws.snapshotId, system: ws.system, userTemplate: ws.userTemplate } })
      .then(setP)
      .catch((e) => setErr(e.message));
  }, [ws.snapshotId, ws.system, ws.userTemplate, promptId]);
  if (!ws.snapshotId) return <Empty>请先在「输入」选择快照（或带请求上下文的样本会在运行时自动建快照）。真实运行只使用快照数据。</Empty>;
  if (err) return <p className="text-stamp">{err}</p>;
  if (!p) return <p className="text-ink-400">构造中…</p>;
  if (!p.ok) return <p className="rounded border border-stamp/40 bg-stamp/10 p-2 text-[12px] text-stamp">无法构造输入：[{p.code}] {p.message}</p>;
  return (
    <div className="space-y-2 text-[12px]" data-testid="request-preview">
      <div className="flex flex-wrap gap-2">
        <Badge>构造器 {p.builderId}</Badge>
        <Badge>prompt hash {p.actualPromptHash?.slice(0, 10)}</Badge>
        <Badge>input hash {p.builtInputHash?.slice(0, 10)}</Badge>
        <Badge tone={p.provider.configured ? "info" : "warn"}>将发送至 {p.provider.provider}</Badge>
      </div>
      {p.requiresFiles?.length ? <p className="rounded border border-stamp/40 bg-stamp/10 p-2 text-stamp">材料 {p.requiresFiles.join(", ")} 没有预处理文本：当前文本模型会阻断运行。</p> : null}
      {p.warnings?.map((w) => (
        <p key={w} className="text-risk">
          ⚠ {w}
        </p>
      ))}
      <pre className="max-h-[50vh] overflow-auto rounded border border-ink-700 bg-ink-950 p-2 text-[11px] whitespace-pre-wrap">{`# system（${p.system?.length} 字）\n${p.system?.slice(0, 600)}${(p.system?.length ?? 0) > 600 ? "…" : ""}\n\n# user\n${p.user}`}</pre>
    </div>
  );
}
