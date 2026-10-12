"use client";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CapabilityDTO, FixtureSummary, PromptVersionDTO, ProviderInfoDTO, SnapshotListItem } from "@/lib/client/types";
import type { PromptKind } from "@/lib/contracts/run";
import { runSnapshotId, useStudio, useWorkspace, type InputMode } from "@/lib/state/studio-store";
import { Badge, Btn, cx, Empty } from "@/components/ui";
import type { InputManifest, ModelParams } from "@/lib/contracts/run";
import { guessMaterialType, skipReason, UPLOAD_EXTS } from "@/lib/materials/guess-type";
import { InputCoverage } from "./input-coverage";
import { PromptEditor } from "./prompt-editor";

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
  onSaveVersion: (label: string, changeNote: string) => Promise<boolean>;
  onPickFixture: (fixtureId: string) => void;
  onSnapshotsChanged: () => void;
  /** 还有更早的快照未加载时提供 */
  onMoreSnapshots?: () => void;
  projectId: string;
}) {
  const [tab, setTab] = useState<EditorTab>("input");
  const [ws, patch] = useWorkspace();
  const version = props.versions.find((v) => v.version_id === ws.versionId);
  const isDraft = !version || version.system_prompt !== ws.system || version.user_prompt_template !== ws.userTemplate;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-pane">
      <div className="flex items-center gap-1 border-b border-ink-700 bg-ink-900 px-3 py-2">
        {(
          [
            ["input", "输入"],
            ["prompt", "提示词"],
            ["model", "模型"],
            ["preview", "请求预览"],
          ] as [EditorTab, string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={cx("rounded-lg px-3 py-1 text-[13px] transition-colors", tab === id ? "bg-ink-800 font-medium text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100")}>
            {label}
            {id === "prompt" && isDraft && <span className="ml-1 text-risk">●</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "prompt" && <PromptTab versions={props.versions} isDraft={isDraft} onSave={props.onSaveVersion} />}
        {tab === "input" && (
          <InputTab
            projectId={props.projectId}
            kind={props.kind}
            fixtures={props.fixtures}
            snapshots={props.snapshots}
            capability={props.capability}
            onPickFixture={props.onPickFixture}
            onSnapshotsChanged={props.onSnapshotsChanged}
            onMoreSnapshots={props.onMoreSnapshots}
          />
        )}
        {tab === "model" && <ModelTab provider={props.provider} />}
        {tab === "preview" && <PreviewTab fixtures={props.fixtures} isDraft={isDraft} versionLabel={version?.label} />}
      </div>
      <div className="border-t border-ink-700 px-3 py-1 text-[11px] text-ink-400">
        输入：{ws.inputMode === "fixture" ? (ws.fixtureId ? `示例 ${ws.fixtureId}` : "还没选示例，请点上方列表里的一项") :ws.inputMode === "paste" ? "粘贴 JSON（仅渲染）" : ws.inputMode === "jiuli" ? "九立导入（导入后使用）" : ws.inputMode === "upload" ? (ws.uploadSnapshotId ? "已上传的文件" : "还没上传文件") : ws.snapshotId ? "已选历史输入" : "还没选历史输入"}
        
      </div>
    </div>
  );
}

function PromptTab({ versions, isDraft, onSave }: { versions: PromptVersionDTO[]; isDraft: boolean; onSave: (label: string, changeNote: string) => Promise<boolean> }) {
  const [ws, patch] = useWorkspace();
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const current = versions.find((v) => v.version_id === ws.versionId);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={ws.versionId ?? ""}
          onChange={(e) => {
            const v = versions.find((x) => x.version_id === e.target.value);
            // 有未保存改动时先确认，避免静默覆盖草稿
            if (v && isDraft && !window.confirm("当前提示词有未保存的修改，切换版本后这些修改会丢失。\n\n确定切换？（取消后可先「保存为新版本」）")) return;
            if (v) patch({ versionId: v.version_id, versionHash: v.content_hash, system: v.system_prompt, userTemplate: v.user_prompt_template });
          }}
          aria-label="Prompt 版本"
          className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px]"
        >
          {versions.map((v) => (
            <option key={v.version_id} value={v.version_id}>
              {v.label} · {v.created_at.slice(0, 16).replace("T", " ")}
            </option>
          ))}
        </select>
        {isDraft ? <Badge tone="warn">未保存草稿</Badge> : <Badge tone="ok">与版本一致</Badge>}
      </div>
      {current && (
        <p className="text-[11px] text-ink-400" data-testid="version-meta">
          {current.parent_version_id ? `父版本 ${versions.find((v) => v.version_id === current.parent_version_id)?.label ?? current.parent_version_id}` : "无父版本"}
          {" · "}创建于 {current.created_at.slice(0, 19).replace("T", " ")}
          {current.change_note ? ` · 变更说明：${current.change_note}` : ""}
        </p>
      )}
      <label className="block text-[11px] text-ink-400">System（提示词正文）</label>
      <PromptEditor system={ws.system} userTemplate={ws.userTemplate} onSystem={(v) => patch({ system: v })} />
      <label className="block text-[11px] text-ink-400">
        User 模板（<code className="text-info">{"{{input_json}}"}</code> 会被替换成输入内容的 JSON）
      </label>
      <textarea
        value={ws.userTemplate}
        onChange={(e) => patch({ userTemplate: e.target.value })}
        aria-label="User 模板"
        spellCheck={false}
        className="h-24 w-full resize-y rounded-lg border border-ink-700 bg-ink-900 p-2 font-mono text-[12px] outline-none focus:border-ink-400"
      />
      <div className="flex items-center gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="新版本名称" aria-label="新版本名称" className="w-40 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px]" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="变更说明：改了哪条规则、影响哪些字段" aria-label="变更说明" className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px]" />
        <Btn
          tone="outline"
          disabled={!isDraft}
          onClick={async () => {
            // 保存失败时保留名称，错误显示在顶栏
            if (await onSave(label || `版本 ${new Date().toLocaleString("zh-CN")}`, note)) {
              setLabel("");
              setNote("");
            }
          }}
        >
          保存为新版本
        </Btn>
      </div>
      <p className="text-[11px] text-ink-400">版本只新增不覆盖；没保存也能运行，运行记录会注明用的是未保存的草稿。</p>
    </div>
  );
}

/** 输入选择（编辑区「输入」页签与结果检查模式的「更换输入」抽屉共用）；onPicked：选定一个输入后回调（抽屉据此收起） */
export function InputTab({
  projectId,
  kind,
  fixtures,
  snapshots,
  capability,
  onPickFixture,
  onSnapshotsChanged,
  onMoreSnapshots,
  onPicked,
}: {
  projectId: string;
  kind: PromptKind;
  fixtures: FixtureSummary[];
  snapshots: SnapshotListItem[];
  capability: CapabilityDTO | null;
  onPickFixture: (fixtureId: string) => void;
  onSnapshotsChanged: () => void;
  onMoreSnapshots?: () => void;
  onPicked?: () => void;
}) {
  const [ws, patch] = useWorkspace();
  // 已选示例时列表默认收起；点「示例」或「更换示例」才展开
  const [fixtureOpen, setFixtureOpen] = useState(false);
  const created = () => {
    onSnapshotsChanged();
    onPicked?.();
  };
  // 常用三种放主位置；粘贴 JSON、九立导入是少用的高级入口，放在右侧小字
  const modes: [InputMode, string][] = [
    ["upload", "上传文件"],
    ["fixture", "示例"],
    ["snapshot", "历史输入"],
  ];
  const more: [InputMode, string][] = [
    ["paste", "粘贴 JSON"],
    ["jiuli", "从九立导入"],
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-0.5 rounded-xl bg-ink-800 p-1 text-[12.5px]">
          {modes.map(([m, l]) => (
            <button
              key={m}
              onClick={() => {
                patch({ inputMode: m });
                if (m === "fixture") setFixtureOpen(true);
              }}
              className={cx("flex-1 whitespace-nowrap rounded-lg px-2 py-1 transition-colors", ws.inputMode === m ? "bg-ink-900 font-medium text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-400">
          更多：
          {more.map(([m, l]) => (
            <button key={m} onClick={() => patch({ inputMode: m })} className={cx("rounded px-1 hover:text-ink-100", ws.inputMode === m && "font-medium text-ink-100 underline")}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {ws.inputMode === "fixture" && (
        <FixtureList
          kind={kind}
          fixtures={fixtures}
          open={fixtureOpen}
          onOpen={() => setFixtureOpen(true)}
          onPick={(id) => {
            setFixtureOpen(false);
            onPickFixture(id);
            onPicked?.();
          }}
        />
      )}
      {ws.inputMode === "paste" && <PasteInput projectId={projectId} kind={kind} onSnapshotsChanged={onSnapshotsChanged} />}
      {ws.inputMode === "snapshot" && <SnapshotList projectId={projectId} kind={kind} snapshots={snapshots} onSnapshotsChanged={onSnapshotsChanged} onMore={onMoreSnapshots} onPicked={onPicked} />}
      {ws.inputMode === "upload" && <UploadInput projectId={projectId} kind={kind} onCreated={created} />}
      {ws.inputMode === "jiuli" && <JiuliImport projectId={projectId} capability={capability} onCreated={created} />}
    </div>
  );
}

const ORIGIN_GROUP = { RECORDED_MODEL_OUTPUT: "真实运行录制（不是标准答案）", CONSTRUCTED: "人工构造的异常示例", STRUCTURE_EXAMPLE: "格式示例" } as const;

/** 样本库（R-01）：按来源分组，支持搜索与来源 / Gold / Schema 版本筛选；已选示例时收起成一张卡片 */
function FixtureList({ kind, fixtures, open, onOpen, onPick }: { kind: PromptKind; fixtures: FixtureSummary[]; open: boolean; onOpen: () => void; onPick: (fixtureId: string) => void }) {
  const [ws] = useWorkspace();
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState<"" | FixtureSummary["origin"]>("");
  const [gold, setGold] = useState(false);
  const [schema, setSchema] = useState("");
  const [usage, setUsage] = useState<"" | "runnable" | "render">("");
  const [ranOnly, setRanOnly] = useState(false);
  const all = fixtures.filter((f) => f.promptKind === kind);
  const schemas = useMemo(() => [...new Set(all.map((f) => f.schemaVersion ?? "（无）"))], [all]);
  const needle = q.trim().toLowerCase();
  const list = all
    .filter(
      (f) =>
        (!origin || f.origin === origin) &&
        (!gold || f.hasGold) &&
        (!schema || (f.schemaVersion ?? "（无）") === schema) &&
        (!usage || (usage === "runnable") === f.hasRequest) &&
        (!ranOnly || (f.stats?.run_count ?? 0) > 0) &&
        (!needle || [f.title, f.id, f.group, ...f.tags].some((x) => x.toLowerCase().includes(needle))),
    )
    // 「只看运行过的」按最近运行时间排序
    .sort((a, b) => (ranOnly ? (b.stats?.last_run_at ?? "").localeCompare(a.stats?.last_run_at ?? "") : 0));
  const picked = all.find((f) => f.id === ws.fixtureId);
  if (!all.length) return <Empty>当前提示词没有示例。可以直接「上传文件」，或在「更多 → 粘贴 JSON」粘贴模型输出。</Empty>;
  if (picked && !open) {
    return (
      <div className="space-y-2" data-testid="fixture-current">
        <FixtureDetailCard f={picked} />
        <Btn onClick={onOpen} data-testid="btn-change-fixture">
          更换示例（共 {all.length} 个）
        </Btn>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="fixture-list">
      <div className="flex flex-wrap items-center gap-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索示例名、样本号、验收项（如 AT09）…" aria-label="搜索样本" className="min-w-40 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] outline-none focus:border-ink-400" />
        <select value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)} aria-label="示例来源" className="rounded-lg border border-ink-700 bg-ink-900 px-1 py-1 text-[11.5px]">
          <option value="">全部来源</option>
          {Object.entries(ORIGIN_GROUP).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={schema} onChange={(e) => setSchema(e.target.value)} aria-label="结构版本" className="rounded-lg border border-ink-700 bg-ink-900 px-1 py-1 text-[11.5px]">
          <option value="">全部结构版本</option>
          {schemas.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select value={usage} onChange={(e) => setUsage(e.target.value as typeof usage)} aria-label="能否真实运行" className="rounded-lg border border-ink-700 bg-ink-900 px-1 py-1 text-[11.5px]">
          <option value="">可运行 + 仅渲染</option>
          <option value="runnable">可真实运行（带输入）</option>
          <option value="render">只能仅渲染</option>
        </select>
        <label className="flex items-center gap-1 text-[11.5px] text-ink-300">
          <input type="checkbox" checked={gold} onChange={(e) => setGold(e.target.checked)} aria-label="只看有 Gold" />
          只看有 Gold
        </label>
        <label className="flex items-center gap-1 text-[11.5px] text-ink-300">
          <input type="checkbox" checked={ranOnly} onChange={(e) => setRanOnly(e.target.checked)} aria-label="只看运行过的" />
          只看运行过的（最近的在前）
        </label>
      </div>
      {picked && <FixtureDetailCard f={picked} />}
      <p className="text-[11px] text-ink-400">
        {list.length}/{all.length} 个示例。录制输出不是标准答案，构造示例不是真实单证，都不能用来说明准确率。
      </p>
      {(Object.keys(ORIGIN_GROUP) as FixtureSummary["origin"][]).map((o) => {
        const items = list.filter((f) => f.origin === o);
        if (!items.length) return null;
        return (
          <div key={o}>
            <div className="mb-0.5 text-[11px] font-semibold text-ink-400">
              {ORIGIN_GROUP[o]} · {items.length}
            </div>
            <ul className="space-y-px">
              {items.map((f) => (
                <li key={f.id}>
                  <button
                    data-fixture-id={f.id}
                    onClick={() => onPick(f.id)}
                    className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] hover:bg-ink-800", ws.fixtureId === f.id && "bg-accent/[0.07] ring-1 ring-accent/40")}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    <FixtureStats f={f} />
                    {f.hasRequest ? <Badge title="带请求上下文：可真实运行，也可解析 evidence_key / 当前值">ctx</Badge> : <Badge tone="mute" title="没有请求上下文：只能仅渲染">仅渲染</Badge>}
                    {f.hasGold && <Badge tone="ok">Gold</Badge>}
                    {f.covers?.length ? <Badge tone="mute">{f.covers.join(" ")}</Badge> : null}
                    <Badge tone={ORIGIN_TONE[f.origin]}>{ORIGIN_SHORT[f.origin]}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!list.length && <Empty>没有符合条件的示例</Empty>}
    </div>
  );
}

/** 样本在本项目里运行过几次、有几处被标为错误；没有输入快照的样本无法关联运行 */
function FixtureStats({ f }: { f: FixtureSummary }) {
  if (!f.stats) return <span className="text-[10.5px] text-ink-600" title="这个示例没有输入快照（只有模型输出），无法统计运行次数">—</span>;
  return (
    <span className="text-[10.5px] whitespace-nowrap text-ink-400" data-testid="fixture-stats" title={f.stats.last_run_at ? `最近运行 ${f.stats.last_run_at.slice(0, 16).replace("T", " ")}` : "还没有运行过"}>
      运行 {f.stats.run_count}
      {f.stats.wrong_count > 0 && <span className="ml-1 text-stamp">标错 {f.stats.wrong_count}</span>}
    </span>
  );
}

function FixtureDetailCard({ f }: { f: FixtureSummary }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-2 text-[11.5px]" data-testid="fixture-detail">
      <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ink-100">{f.title}</span>
        <Badge tone={ORIGIN_TONE[f.origin]}>{ORIGIN_GROUP[f.origin]}</Badge>
        <Badge tone={f.hasGold ? "ok" : "mute"}>{f.hasGold ? "有独立 Gold" : "无 Gold"}</Badge>
        <Badge>{f.schemaVersion ?? "无 schema_version"}</Badge>
        <Badge tone={f.detail.runnable ? "info" : "warn"}>{f.detail.runnable ? "可真实运行 / 仅渲染" : "只能仅渲染"}</Badge>
      </div>
      <div className="text-ink-400" data-testid="fixture-summary">
        文件 {f.detail.materials.length} 个 · 输入{f.hasRequest ? "完整（带请求上下文）" : "缺失（只有模型输出）"} ·{" "}
        {f.stats ? `运行 ${f.stats.run_count} 次${f.stats.last_run_at ? `（最近 ${f.stats.last_run_at.slice(0, 16).replace("T", " ")}）` : ""} · 标为错误 ${f.stats.wrong_count} 处` : "无法关联运行"}
      </div>
      {f.detail.provenance && <div className="text-ink-400">{f.detail.provenance}</div>}
      {f.detail.materials.length > 0 && (
        <div className="text-ink-400">
          素材：{f.detail.materials.map((m) => `${m.file_id}${m.type ? `（${m.type}）` : ""}${m.segments.length ? ` ${m.segments.join(",")}` : ""}`).join("；")}
        </div>
      )}
      {f.detail.upstream && <div className="text-ink-400">上游：{f.detail.upstream}</div>}
      {f.tags.length > 0 && <div className="text-ink-400">标签：{f.tags.join("、")}</div>}
    </div>
  );
}

function PasteInput({ projectId, kind, onSnapshotsChanged }: { projectId: string; kind: PromptKind; onSnapshotsChanged: () => void }) {
  const [ws, patch] = useWorkspace();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readFile = (f: File, key: "pasteRaw" | "pasteRequest") => f.text().then((t) => patch({ [key]: t }));

  /** 把粘贴的请求上下文存为快照并选中，之后可直接真实运行 */
  async function saveRequest() {
    setErr(null);
    setBusy(true);
    try {
      const snap = await api<{ snapshot_id: string }>("/api/snapshots/import", { json: { projectId, label: "粘贴的请求", promptKind: kind, requestText: ws.pasteRequest } });
      patch({ inputMode: "snapshot", snapshotId: snap.snapshot_id });
      onSnapshotsChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-400">模型原始输出（原样保存，不做任何修改）</label>
      <textarea value={ws.pasteRaw} onChange={(e) => patch({ pasteRaw: e.target.value })} aria-label="原始输出" spellCheck={false} placeholder='{"schema_version":"jiuli-ai-v3", ...}' className="h-56 w-full rounded-lg border border-ink-700 bg-ink-900 p-2 font-mono text-[12px] outline-none focus:border-ink-400" />
      <input type="file" accept=".json,.txt" aria-label="上传原始输出文件" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], "pasteRaw")} className="text-[11px] text-ink-400" />
      <label className="block text-[11px] text-ink-400">请求上下文 JSON（可选，v3 P3/P4 用于解析 evidence_key、当前值）</label>
      <textarea value={ws.pasteRequest} onChange={(e) => patch({ pasteRequest: e.target.value })} aria-label="请求上下文" spellCheck={false} className="h-28 w-full rounded-lg border border-ink-700 bg-ink-900 p-2 font-mono text-[12px] outline-none focus:border-ink-400" />
      <input type="file" accept=".json" aria-label="上传请求上下文文件" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], "pasteRequest")} className="text-[11px] text-ink-400" />
      <div className="flex items-center gap-2">
        <Btn tone="outline" disabled={busy || !ws.pasteRequest.trim()} onClick={saveRequest}>
          {busy ? "保存中…" : "把请求存为输入（用于真实运行）"}
        </Btn>
        <span className="text-[11px] text-ink-400">存好后自动切到「历史输入」并选中，可直接「运行模型」。</span>
      </div>
      {err && <p className="text-[12px] text-stamp">{err}</p>}
    </div>
  );
}

const KIND_SHORT: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4", GENERIC_JSON: "通用" };

function SnapshotList({ projectId, kind, snapshots, onSnapshotsChanged, onMore, onPicked }: { projectId: string; kind: PromptKind; snapshots: SnapshotListItem[]; onSnapshotsChanged: () => void; onMore?: () => void; onPicked?: () => void }) {
  const [ws, patch] = useWorkspace();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!snapshots.length) return <Empty>还没有历史输入。上传文件、粘贴 JSON 或九立导入后会出现在这里。</Empty>;
  const usable = snapshots.filter((s) => s.usable_kinds.includes(kind));
  const hidden = snapshots.length - usable.length;
  const list = showAll ? snapshots : usable;

  /** 重新只读读取同一来源，生成新快照（记录 parent），旧快照与旧 Run 不变 */
  async function refresh(s: SnapshotListItem) {
    setBusy(s.snapshot_id);
    setErr(null);
    try {
      const n = await api<{ snapshot_id: string }>("/api/connectors/jiuli/snapshots", {
        json: { projectId, customerId: s.source_ids.customer_id, taskId: s.source_ids.task_id, batchIds: s.source_ids.batch_ids ?? [], excludeFileIds: s.source_ids.excluded_file_ids ?? [], parentSnapshotId: s.snapshot_id },
      });
      patch({ snapshotId: n.snapshot_id });
      onSnapshotsChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function setRetention(id: string, days: number | null) {
    setErr(null);
    try {
      await api(`/api/snapshots/${id}/retention`, { json: { days } });
      onSnapshotsChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  }

  /** 删除快照内容（Studio 自有数据）；所有工作区对它的引用一并清除 */
  async function remove(s: SnapshotListItem) {
    if (!window.confirm(`删除输入「${s.label}」？\n\n这份输入和材料记录会被删除，无法恢复；用过它的运行记录和原始输出保留，但不能再用它重跑。九立数据不受影响。`)) return;
    setErr(null);
    try {
      await api(`/api/snapshots/${s.snapshot_id}`, { method: "DELETE" });
      const st = useStudio.getState();
      for (const [pid, w] of Object.entries(st.workspaces)) {
        if (w.snapshotId === s.snapshot_id) st.patchWorkspace(pid, { snapshotId: null });
        if (w.fixtureSnapshotId === s.snapshot_id) st.patchWorkspace(pid, { fixtureSnapshotId: null });
        if (w.uploadSnapshotId === s.snapshot_id) st.patchWorkspace(pid, { uploadSnapshotId: null });
      }
      onSnapshotsChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  }

  return (
    <div className="space-y-1" data-testid="snapshot-list">
      <div className="flex items-center gap-2 text-[11px] text-ink-400">
        <span>
          显示可用于 {KIND_SHORT[kind]} 的输入 {usable.length} 个
          {hidden > 0 && `，另有 ${hidden} 个不适用`}
        </span>
        {hidden > 0 && (
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} aria-label="显示全部输入" />
            显示全部
          </label>
        )}
      </div>
      {!list.length && <Empty>没有可用于 {KIND_SHORT[kind]} 的输入。</Empty>}
      <ul className="space-y-px">
        {list.map((s) => {
          const ok = s.usable_kinds.includes(kind);
          return (
            <li key={s.snapshot_id} className="flex items-start gap-1">
              <button
                disabled={!ok}
                onClick={() => {
                  patch({ snapshotId: s.snapshot_id });
                  onPicked?.();
                }}
                data-snapshot-id={s.snapshot_id}
                className={cx("min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-[12px] hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50", ws.snapshotId === s.snapshot_id && "bg-accent/[0.07] ring-1 ring-accent/40")}
              >
                <div className="flex items-center gap-2">
                  <Badge tone={s.source_type === "JIULI_READONLY" ? "info" : "mute"}>{s.source_type}</Badge>
                  <span className="truncate">{s.label}</span>
                  {!ok && <Badge tone="warn">不适用于 {KIND_SHORT[kind]}</Badge>}
                </div>
                <div className="font-mono text-[10.5px] text-ink-400">
                  {s.snapshot_id} · {s.imported_at.slice(0, 19).replace("T", " ")} · hash {s.content_hash.slice(0, 10)}
                  {s.parent_snapshot_id && ` · 刷新自 ${s.parent_snapshot_id}`}
                  {" · 可用于 "}
                  {s.usable_kinds.filter((k) => k !== "GENERIC_JSON").map((k) => KIND_SHORT[k]).join("/") || "—"}
                </div>
              </button>
              <select
                value=""
                onChange={(e) => e.target.value && setRetention(s.snapshot_id, e.target.value === "never" ? null : Number(e.target.value))}
                aria-label={`保留期限 ${s.snapshot_id}`}
                title={s.expires_at ? `到期：${s.expires_at.slice(0, 16).replace("T", " ")}` : "永不到期"}
                className="w-[72px] shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-1 py-0.5 text-[11px] text-ink-300"
              >
                <option value="">{s.expires_at ? `至 ${s.expires_at.slice(5, 10)}` : "永久"}</option>
                <option value="never">永久保留</option>
                <option value="7">7 天后删</option>
                <option value="30">30 天后删</option>
                <option value="90">90 天后删</option>
              </select>
              <Btn onClick={() => remove(s)} aria-label={`删除输入 ${s.snapshot_id}`} title="删除这份输入（无法恢复）">
                删除
              </Btn>
              {s.source_type === "JIULI_READONLY" && (
                <Btn onClick={() => refresh(s)} disabled={busy !== null} title="重新只读读取同一客户/任务/批次，生成新的输入；旧的不变" aria-label={`刷新输入 ${s.snapshot_id}`}>
                  {busy === s.snapshot_id ? "读取中…" : "刷新"}
                </Btn>
              )}
            </li>
          );
        })}
      </ul>
      {onMore && (
        <Btn onClick={onMore} className="w-full justify-center">
          加载更早的输入（已显示最近 {snapshots.length} 个）
        </Btn>
      )}
      {err && <p className="text-[12px] text-stamp">{err}</p>}
    </div>
  );
}

const UPLOAD_TYPES: [string, string][] = [
  ["ORDER", "委托单（P1）"],
  ["INVOICE", "发票（P1）"],
  ["PACKING_LIST", "箱单（P1）"],
  ["INSPECTION", "查货文件（P2）"],
];

interface PickedFile {
  file: File;
  /** 文件夹内相对路径；单独选的文件就是文件名 */
  path: string;
  type: string;
}

/** 递归读取拖入的文件夹（webkitGetAsEntry），返回 [相对路径, File] */
async function readEntry(entry: FileSystemEntry, prefix = ""): Promise<[string, File][]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [[prefix + entry.name, file]];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const out: [string, File][] = [];
  // readEntries 每次最多返回 100 项，读到空为止
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...(await readEntry(e, `${prefix}${entry.name}/`)));
  }
  return out;
}

/** 上传原件（PDF / Excel / 图片），可拖入整个文件夹；材料类型按文件名自动判断，需要时可改 */
function UploadInput({ projectId, kind, onCreated }: { projectId: string; kind: PromptKind; onCreated: () => void }) {
  const [ws, patch] = useWorkspace();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ snapshot_id: string; label: string; warnings: string[] } | null>(null);
  const jiuli = kind !== "GENERIC_JSON";

  function add(list: [string, File][]) {
    const ok: PickedFile[] = [];
    const skip: { path: string; reason: string }[] = [];
    for (const [path, file] of list) {
      const reason = skipReason(path);
      if (reason) skip.push({ path, reason });
      else if (!files.some((f) => f.path === path)) ok.push({ file, path, type: guessMaterialType(path, kind) });
    }
    setFiles([...files, ...ok]);
    setSkipped(skip);
    setResult(null);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
    add(entries.length ? (await Promise.all(entries.map((x) => readEntry(x)))).flat() : [...e.dataTransfer.files].map((f) => [f.name, f]));
  }

  async function upload() {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("projectId", projectId);
      fd.set("label", label);
      fd.set("customerName", customerName);
      for (const f of files) {
        fd.append("files", f.file);
        fd.append("paths", f.path);
        fd.append("types", f.type);
      }
      const s = await api<{ snapshot_id: string; label: string; warnings: string[] }>("/api/snapshots/files", { method: "POST", body: fd });
      setResult(s);
      patch({ uploadSnapshotId: s.snapshot_id });
      setFiles([]);
      setSkipped([]);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-[12px]" data-testid="upload-input">
      {(kind === "JIULI_P3" || kind === "JIULI_P4") && (
        <p className="rounded-lg border border-risk/40 bg-risk/10 px-2 py-1 text-risk" data-testid="upload-kind-note">
          原件只能构造 P1（委托单/发票/箱单）和 P2（查货文件）的输入；{kind === "JIULI_P3" ? "P3" : "P4"} 需要上游的结构化结果，不能直接由原件构造。仍可上传，建好的输入可切到 P1 / P2 或通用提示词使用。
        </p>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="upload-drop"
        className={cx("rounded-xl border-2 border-dashed p-4 text-center", over ? "border-info bg-info/5" : "border-ink-700")}
      >
        <p className="text-ink-300">把文件或整个文件夹拖到这里</p>
        <p className="mt-0.5 text-[11px] text-ink-400">支持 PDF、Excel、PNG、JPG；文件夹里的子文件夹也会读取，其他格式自动跳过</p>
        <div className="mt-2 flex justify-center gap-2">
          <label className="cursor-pointer rounded-lg border border-ink-700 px-2 py-1 hover:bg-ink-850">
            选择文件
            <input type="file" multiple accept={UPLOAD_EXTS.join(",")} aria-label="选择原件文件" className="hidden" onChange={(e) => (add([...(e.target.files ?? [])].map((f) => [f.name, f])), (e.target.value = ""))} />
          </label>
          <label className="cursor-pointer rounded-lg border border-ink-700 px-2 py-1 hover:bg-ink-850">
            选择文件夹
            <input
              type="file"
              aria-label="选择文件夹"
              className="hidden"
              ref={(el) => el?.setAttribute("webkitdirectory", "")}
              onChange={(e) => (add([...(e.target.files ?? [])].map((f) => [f.webkitRelativePath || f.name, f])), (e.target.value = ""))}
            />
          </label>
        </div>
      </div>
      {files.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-auto" data-testid="upload-files">
          <li className="text-ink-400">
            共 {files.length} 个文件{jiuli ? "，材料类型已按文件名自动判断，不对可以改" : ""}
          </li>
          {files.map((f, i) => (
            <li key={f.path} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={f.path}>
                {f.path}
              </span>
              {jiuli && (
                <select
                  value={f.type}
                  onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                  aria-label={`材料类型 ${f.path}`}
                  className="rounded-lg border border-ink-700 bg-ink-900 px-1 py-0.5"
                >
                  {UPLOAD_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
              <button onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-ink-400 hover:text-stamp" aria-label={`移除 ${f.path}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <details className="text-ink-400" data-testid="upload-skipped">
          <summary>已跳过 {skipped.length} 个文件</summary>
          {skipped.map((x) => (
            <div key={x.path} className="truncate">
              {x.path}：{x.reason}
            </div>
          ))}
        </details>
      )}
      {jiuli && <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="客户名称（可选，用于 P1 客户目录 / P2 客户）" aria-label="客户名称" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1" />}
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="给这组输入起个名字（可选）" aria-label="输入名称" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1" />
      <Btn tone="primary" disabled={busy || !files.length} onClick={upload}>
        {busy ? "上传并读取中…" : files.length ? `上传 ${files.length} 个文件` : "上传"}
      </Btn>
      {err && <p className="text-stamp">{err}</p>}
      {result && ws.uploadSnapshotId === result.snapshot_id && (
        <div className="rounded-lg border border-verify/40 bg-verify/5 p-2" data-testid="upload-result">
          <div>✓ 已上传：{result.label}，可以直接运行</div>
          {result.warnings.map((w) => (
            <div key={w} className="text-risk">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-ink-400">文字型 PDF 和 Excel 会抽取文字；扫描件和图片靠模型看图（模型支持看图时自动附带）。原件只保存在本机，不写回九立。</p>
    </div>
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
interface SelectionFile {
  file_id: string;
  file_name: string;
  role: "ORDER" | "SUPPORTING" | "INSPECTION";
  optional: boolean;
  authorized: boolean;
  exists: boolean;
  has_text_content: boolean;
  segments: string[];
}
const ROLE_LABEL = { ORDER: "主委托文件", SUPPORTING: "辅助材料", INSPECTION: "查货文件" } as const;
const SEGMENT_LABEL: Record<string, string> = { invoice: "发票", "packing-list": "箱单", entrustment: "委托书" };

/** 九立只读导入：选客户 → 任务/查货批次 → 创建 Studio 隔离快照。不向九立写任何数据。 */
function JiuliImport({ projectId, capability, onCreated }: { projectId: string; capability: CapabilityDTO | null; onCreated: () => void }) {
  const [, patch] = useWorkspace();
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [task, setTask] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 本次将带上的文件；excluded 为用户取消勾选的辅助材料 */
  const [files, setFiles] = useState<SelectionFile[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
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

  // 选择变化时重新列出将带上的文件，默认全部纳入
  const batchKey = [...picked].sort().join(",");
  useEffect(() => {
    setFiles(null);
    setExcluded(new Set());
    if (!customer || (!task && !batchKey)) return;
    api<SelectionFile[]>(`/api/connectors/jiuli/files?customerId=${encodeURIComponent(customer)}&taskId=${encodeURIComponent(task)}&batchIds=${encodeURIComponent(batchKey)}`)
      .then(setFiles)
      .catch((e) => setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)));
  }, [customer, task, batchKey]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<{ snapshot_id: string; warnings: string[] }>("/api/connectors/jiuli/snapshots", {
        json: { projectId, customerId: customer, taskId: task || undefined, batchIds: [...picked], excludeFileIds: [...excluded] },
      });
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
      <div className={cx("rounded-lg border p-2 text-[12px]", connected ? "border-verify/40 bg-verify/5" : "border-risk/40 bg-risk/10")}>
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索客户（仅显示已授权客户）" aria-label="搜索客户" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px]" />
          <ul className="max-h-36 overflow-auto rounded-lg border border-ink-800">
            {customers.map((c) => (
              <li key={c.customer_id}>
                <button onClick={() => setCustomer(c.customer_id)} className={cx("w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-ink-800", customer === c.customer_id && "bg-accent/[0.07] text-accent")}>
                  {c.name} <span className="font-mono text-[10.5px] text-ink-400">{c.customer_id}</span>
                </button>
              </li>
            ))}
          </ul>
          {customer && (
            <>
              <label className="block text-[11px] text-ink-400">委托任务</label>
              <select value={task} onChange={(e) => setTask(e.target.value)} aria-label="委托任务" className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[12px]">
                <option value="">（不选任务）</option>
                {tasks.map((t) => (
                  <option key={t.task_id} value={t.task_id}>
                    {t.task_id} · {t.sample_id} · {t.line_count} 行 · {t.status}
                  </option>
                ))}
              </select>
              <label className="block text-[11px] text-ink-400">查货批次（可多选）</label>
              <ul className="max-h-36 overflow-auto rounded-lg border border-ink-800">
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
              {files && (
                <div data-testid="selection-files">
                  <label className="block text-[11px] text-ink-400">
                    将带上的文件（{files.length - excluded.size}/{files.length}）
                  </label>
                  <ul className="max-h-40 overflow-auto rounded-lg border border-ink-800">
                    {files.map((f) => (
                      <li key={f.file_id} className="flex items-center gap-2 px-2 py-0.5 text-[12px]">
                        <input
                          type="checkbox"
                          checked={!excluded.has(f.file_id)}
                          disabled={!f.optional}
                          onChange={(e) => setExcluded((x) => (e.target.checked ? new Set([...x].filter((id) => id !== f.file_id)) : new Set([...x, f.file_id])))}
                          aria-label={`纳入文件 ${f.file_id}`}
                          title={f.optional ? "取消勾选则不纳入输入、不发送给模型" : "由上方任务/批次决定；不需要请取消对应任务或批次"}
                        />
                        <Badge tone={f.role === "SUPPORTING" ? "info" : "mute"}>{ROLE_LABEL[f.role]}</Badge>
                        <span className="min-w-0 flex-1 truncate" title={`${f.file_id} · ${f.file_name}`}>
                          {f.file_name}
                        </span>
                        {f.segments.length > 0 && <span className="text-[10.5px] text-ink-400">{[...new Set(f.segments.map((k) => SEGMENT_LABEL[k] ?? k))].join("/")}</span>}
                        {!f.authorized ? <Badge tone="bad">无权读取</Badge> : !f.exists ? <Badge tone="bad">原件缺失</Badge> : !f.has_text_content && <Badge tone="warn">无可读文本</Badge>}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[10.5px] text-ink-400">主委托文件与查货文件由任务/批次决定；发票、箱单等辅助材料可取消勾选。</p>
                </div>
              )}
              <Btn tone="primary" disabled={busy || (!task && !picked.size)} onClick={create}>
                {busy ? "读取中…" : "只读读取并保存为输入"}
              </Btn>
            </>
          )}
        </>
      )}
      {err && <p className="text-[12px] text-stamp">{err}</p>}
      <p className="text-[11px] text-ink-400">运行时不会再偷偷拉取新数据；需要更新时重新导入，生成新的输入，旧输入和旧运行记录保留。</p>
    </div>
  );
}

function ModelTab({ provider }: { provider: ProviderInfoDTO | null }) {
  const [ws, patch] = useWorkspace();
  return (
    <div className="space-y-3 text-[12px]">
      <div className={cx("rounded-lg border p-2", provider?.configured ? "border-verify/40" : "border-risk/40 bg-risk/10")}>
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
        <p className="text-ink-400">文件直传：{provider?.supportsFileInput ? "支持" : "不支持（默认只发送预处理文本；缺文本的材料会被阻断。看图请勾选下方「附带原件图片」）"}</p>
      </div>
      {provider?.capabilities && <CapabilityTable caps={provider.capabilities} />}
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={ws.attachImages ?? provider?.capabilities?.images === true} onChange={(e) => patch({ attachImages: e.target.checked })} aria-label="附带原件图片" className="mt-0.5" />
        <span>
          附带原件图片
          <span className="block text-ink-400">
            把输入里的 PDF / 图片原件逐页转成图片，和文字一起发送（默认最多 20 页，可用 MODEL_MAX_IMAGE_PAGES 调整）。Excel 不转图。
            {ws.attachImages === null ? "当前跟随模型能力：模型支持看图时，有 PDF / 图片就自动附带。" : ""}
          </span>
          {ws.attachImages !== null && (
            <button type="button" onClick={() => patch({ attachImages: null })} className="text-info hover:underline">
              恢复默认（跟随模型能力）
            </button>
          )}
        </span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-ink-400">temperature</span>
        <input type="number" step="0.1" min={0} max={2} value={ws.params.temperature} onChange={(e) => patch({ params: { ...ws.params, temperature: Number(e.target.value) } })} aria-label="temperature" className="w-24 rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5" />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-ink-400">max_tokens</span>
        <input type="number" step="1000" min={1} value={ws.params.max_tokens} onChange={(e) => patch({ params: { ...ws.params, max_tokens: Number(e.target.value) } })} aria-label="max_tokens" className="w-24 rounded-lg border border-ink-700 bg-ink-900 px-2 py-0.5" />
      </label>
    </div>
  );
}

const capText = (v: boolean | null) => (v === null ? "未声明" : v ? "支持" : "不支持");

/** 模型能力声明（R-04）：来自 .env.local，未声明的如实显示，不当作支持 */
function CapabilityTable({ caps }: { caps: NonNullable<ProviderInfoDTO["capabilities"]> }) {
  const rows: [string, string, string][] = [
    ["图片输入", capText(caps.images), "MODEL_SUPPORTS_IMAGES；声明不支持时勾选「附带原件图片」会被阻断"],
    ["原生 PDF", "不支持", "本适配器不直传 PDF，PDF 只能转文本或转页图"],
    ["JSON 模式", capText(caps.jsonMode), "MODEL_SUPPORTS_JSON_MODE；只作说明，请求中不发送 response_format"],
    ["Thinking", capText(caps.thinking), "MODEL_SUPPORTS_THINKING；只作说明，不发送 thinking 参数"],
    ["流式输出", "不使用", "本适配器只用非流式请求"],
    ["输出 token 上限", caps.maxOutputTokens ? String(caps.maxOutputTokens) : "未声明", "MODEL_MAX_OUTPUT_TOKENS；max_tokens 超过上限会被阻断"],
  ];
  return (
    <table className="w-full text-[11.5px]" data-testid="capability-table">
      <tbody>
        {rows.map(([k, v, hint]) => (
          <tr key={k} className="border-b border-ink-800">
            <td className="w-28 py-0.5 text-ink-400">{k}</td>
            <td className={cx("w-20 py-0.5", v === "未声明" && "text-risk")}>{v}</td>
            <td className="py-0.5 text-[10.5px] text-ink-400">{hint}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  attachFiles?: { file_id: string; file_name: string; media_type: string; authorized: boolean; exists: boolean }[] | null;
  provider: ProviderInfoDTO;
  params?: ModelParams;
  tokenEstimate?: number;
  blockers?: { code: string; message: string }[];
  manifest?: InputManifest;
}

/** 预览中 system 默认只显示开头，可展开全文 */
const PREVIEW_HEAD = 600;

function PreviewTab({ fixtures, isDraft, versionLabel }: { fixtures: FixtureSummary[]; isDraft: boolean; versionLabel?: string }) {
  const [ws, , promptId] = useWorkspace();
  // 与「运行模型」同一来源，保证预览的就是要发送的
  const snapshotId = runSnapshotId(ws);
  const [p, setP] = useState<PreviewDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fullSystem, setFullSystem] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setP(null);
    setErr(null);
    if (!snapshotId) return;
    api<PreviewDTO>("/api/runs/preview", { json: { promptId, snapshotId, system: ws.system, userTemplate: ws.userTemplate, attachImages: ws.attachImages ?? undefined, params: ws.params } })
      .then(setP)
      .catch((e) => setErr(e.message));
  }, [snapshotId, ws.system, ws.userTemplate, ws.attachImages, ws.params, promptId]);
  if (!snapshotId) {
    const why =
      ws.inputMode === "fixture"
        ? !ws.fixtureId
          ? "请先在「输入 → 示例」选择一个示例。"
          : !fixtures.find((f) => f.id === ws.fixtureId)?.hasRequest
            ? "这个示例没有附带输入（无 ctx 标记），不能真实运行，只能「仅渲染」。"
            : "正在准备示例输入…"
        : ws.inputMode === "paste"
          ? "粘贴的模型输出只用于「仅渲染」。要真实运行，请上传文件，或把粘贴的请求「存为输入」。"
          : ws.inputMode === "upload"
            ? "请先在「输入 → 上传文件」上传文件。"
          : ws.inputMode === "jiuli"
            ? "请先在「输入 → 更多 → 从九立导入」导入数据。"
            : "请先在「输入 → 历史输入」选一个。";
    return <Empty>{why}</Empty>;
  }
  if (err) return <p className="text-stamp">{err}</p>;
  if (!p) return <p className="text-ink-400">构造中…</p>;
  if (!p.ok) return <p className="rounded-lg border border-stamp/40 bg-stamp/10 p-2 text-[12px] text-stamp">无法构造输入：[{p.code}] {p.message}</p>;
  return (
    <div className="space-y-2 text-[12px]" data-testid="request-preview">
      <div className="flex flex-wrap gap-2">
        <Badge>构造器 {p.builderId}</Badge>
        <Badge>prompt hash {p.actualPromptHash?.slice(0, 10)}</Badge>
        <Badge>input hash {p.builtInputHash?.slice(0, 10)}</Badge>
        <Badge tone={p.provider.configured ? "info" : "warn"}>将发送至 {p.provider.provider}</Badge>
        <Badge tone={isDraft ? "warn" : "ok"}>{isDraft ? `含未保存草稿（基于 ${versionLabel ?? "无版本"}）` : `版本 ${versionLabel}`}</Badge>
        <Badge>参数 {JSON.stringify(p.params ?? {})}</Badge>
        {p.tokenEstimate !== undefined && <Badge title="按字符数粗估，不含图片，误差可能较大">≈ {p.tokenEstimate.toLocaleString()} 输入 token（粗估）</Badge>}
      </div>
      {p.blockers?.length ? (
        <div className="rounded-lg border border-stamp/50 bg-stamp/10 p-2 text-stamp" data-testid="preview-blockers">
          <div className="font-semibold">以下问题会阻止运行：</div>
          {p.blockers.map((b) => (
            <div key={b.code + b.message}>
              [{b.code}] {b.message}
            </div>
          ))}
        </div>
      ) : null}
      {p.manifest && <InputCoverage manifest={p.manifest} planned />}
      {p.requiresFiles?.length ? <p className="rounded-lg border border-stamp/40 bg-stamp/10 p-2 text-stamp">材料 {p.requiresFiles.join(", ")} 没有预处理文本：当前文本模型会阻断运行（PDF / 图片可勾选「附带原件图片」）。</p> : null}
      {p.attachFiles && (
        <div className="rounded-lg border border-ink-700 p-2" data-testid="attach-files">
          <div className="text-ink-400">将附带原件图片（运行时转换；不是 PDF / 图片或无权读取的会跳过并记入警告）：</div>
          {p.attachFiles.length ? (
            p.attachFiles.map((f) => (
              <div key={f.file_id} className="font-mono text-[11px]">
                {f.file_id} · {f.file_name} · {f.media_type}
                {!f.authorized ? " · 无权读取" : !f.exists ? " · 原件不存在" : ""}
              </div>
            ))
          ) : (
            <div className="text-risk">构造输入没有引用原件文件，不会附带图片</div>
          )}
        </div>
      )}
      {p.warnings?.map((w) => (
        <p key={w} className="text-risk">
          ⚠ {w}
        </p>
      ))}
      <div className="flex items-center gap-2">
        {(p.system?.length ?? 0) > PREVIEW_HEAD && (
          <Btn onClick={() => setFullSystem((v) => !v)}>{fullSystem ? "收起 system" : `展开 system 全文（${p.system?.length} 字）`}</Btn>
        )}
        <Btn
          onClick={() =>
            navigator.clipboard?.writeText(`# system\n${p.system ?? ""}\n\n# user\n${p.user ?? ""}`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "已复制" : "复制全部发送内容"}
        </Btn>
      </div>
      <pre className="max-h-[50vh] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-2 text-[11px] whitespace-pre-wrap" data-testid="preview-text">
        {`# system（${p.system?.length} 字）\n${fullSystem ? p.system : p.system?.slice(0, PREVIEW_HEAD)}${!fullSystem && (p.system?.length ?? 0) > PREVIEW_HEAD ? "…（已折叠，点上方「展开」查看全文）" : ""}\n\n# user\n${p.user}`}
      </pre>
    </div>
  );
}
