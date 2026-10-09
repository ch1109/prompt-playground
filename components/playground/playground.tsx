"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CapabilityDTO, FixtureSummary, PromptDef, PromptVersionDTO, ProviderInfoDTO, RunDetail, RunListItem, SnapshotListItem } from "@/lib/client/types";
import { emptyWorkspace, inputSignature, useStudio } from "@/lib/state/studio-store";
import { Badge, Btn, cx, RUN_STATUS_LABEL, RUN_STATUS_TONE } from "@/components/ui";
import { EditorPane } from "./editor-pane";
import { ResultPane } from "./result-pane";
import { RunCompare } from "./run-compare";

const SHORT: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4", GENERIC_JSON: "{ }" };

export function Playground({ projectId }: { projectId: string }) {
  const s = useStudio();
  const [prompts, setPrompts] = useState<PromptDef[]>([]);
  const [versions, setVersions] = useState<Record<string, PromptVersionDTO[]>>({});
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotListItem[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [provider, setProvider] = useState<ProviderInfoDTO | null>(null);
  const [capability, setCapability] = useState<CapabilityDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  const promptId = s.activePromptId;
  const prompt = prompts.find((p) => p.prompt_id === promptId);
  const ws = s.workspaces[promptId] ?? emptyWorkspace();
  const detail = ws.runId ? s.runs[ws.runId] : undefined;
  const lastMode = s.lastMode[promptId];
  const dirty = !!detail && !!ws.runInputSig && !!lastMode && inputSignature(ws, lastMode) !== ws.runInputSig;

  const loadRuns = useCallback(() => api<RunListItem[]>(`/api/runs?project=${projectId}`).then(setRuns), [projectId]);
  const loadSnapshots = useCallback(() => api<SnapshotListItem[]>(`/api/snapshots?project=${projectId}`).then(setSnapshots), [projectId]);

  useEffect(() => {
    api<PromptDef[]>(`/api/prompts?project=${projectId}`).then(setPrompts).catch((e) => setError(e.message));
    api<{ items: FixtureSummary[] }>("/api/fixtures").then((r) => setFixtures(r.items));
    api<ProviderInfoDTO>("/api/models").then(setProvider);
    api<CapabilityDTO>("/api/connectors/jiuli/capabilities").then(setCapability).catch(() => setCapability(null));
    loadRuns();
    loadSnapshots();
  }, [projectId, loadRuns, loadSnapshots]);

  // 加载当前 Prompt 的版本，首次进入时用最新版本初始化工作草稿
  useEffect(() => {
    if (!promptId || versions[promptId]) return;
    api<{ versions: PromptVersionDTO[] }>(`/api/prompts/${promptId}`).then((r) => {
      setVersions((v) => ({ ...v, [promptId]: r.versions }));
      const cur = useStudio.getState().workspaces[promptId];
      const latest = r.versions[0];
      if (!cur?.versionId && latest) s.patchWorkspace(promptId, { versionId: latest.version_id, versionHash: latest.content_hash, system: latest.system_prompt, userTemplate: latest.user_prompt_template });
    });
  }, [promptId, versions, s]);

  const openRun = useCallback(
    async (runId: string, opts?: { sig?: string; mode?: "RENDER_ONLY" | "MODEL_RUN" }) => {
      const d = await api<RunDetail>(`/api/runs/${runId}`);
      s.putRun(d);
      const target = d.run.prompt_id;
      if (target !== useStudio.getState().activePromptId) s.setActivePrompt(target);
      s.patchWorkspace(target, { runId, runInputSig: opts?.sig ?? null });
      if (opts?.mode) s.set("lastMode", { ...useStudio.getState().lastMode, [target]: opts.mode });
      s.set("selection", { runId });
    },
    [s],
  );

  async function renderOnly() {
    setError(null);
    setBusy(true);
    try {
      let snapshotId: string | null = null;
      const body: Record<string, unknown> = { mode: "RENDER_ONLY", projectId, promptId };
      if (ws.inputMode === "fixture") {
        if (!ws.fixtureId) throw new Error("请先在「输入 → 样本库」选择样本");
        body.fixtureId = ws.fixtureId;
      } else if (ws.inputMode === "paste") {
        if (!ws.pasteRaw.trim()) throw new Error("请粘贴模型原始输出");
        if (ws.pasteRequest.trim()) {
          const snap = await api<{ snapshot_id: string }>("/api/snapshots/import", { json: { projectId, label: "粘贴的请求上下文", promptKind: prompt?.prompt_kind, requestText: ws.pasteRequest } });
          snapshotId = snap.snapshot_id;
        }
        body.raw = ws.pasteRaw;
        body.snapshotId = snapshotId;
        body.label = "粘贴 JSON";
      } else {
        throw new Error("「仅渲染」需要样本或粘贴的 JSON；快照输入请使用「运行模型」");
      }
      const run = await api<{ run_id: string }>("/api/runs", { json: body });
      await openRun(run.run_id, { sig: inputSignature(ws, "RENDER_ONLY"), mode: "RENDER_ONLY" });
      loadRuns();
      loadSnapshots();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function modelRun() {
    setError(null);
    setBusy(true);
    try {
      let snapshotId = ws.snapshotId;
      if (ws.inputMode === "fixture") {
        if (!ws.fixtureId) throw new Error("请选择样本");
        const snap = await api<{ snapshot_id: string }>("/api/snapshots/import", { json: { projectId, fixtureId: ws.fixtureId } });
        snapshotId = snap.snapshot_id;
        s.patchWorkspace(promptId, { snapshotId });
      }
      if (!snapshotId) throw new Error("真实运行必须选择输入快照（样本需带请求上下文，或从九立只读导入）");
      const run = await api<{ run_id: string }>("/api/runs", {
        json: { mode: "MODEL_RUN", projectId, promptId, snapshotId, system: ws.system, userTemplate: ws.userTemplate, promptVersionId: ws.versionId, params: ws.params },
      });
      await openRun(run.run_id, { sig: inputSignature({ ...ws, snapshotId }, "MODEL_RUN"), mode: "MODEL_RUN" });
      loadRuns();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion(label: string) {
    const v = await api<PromptVersionDTO>(`/api/prompts/${promptId}/versions`, { json: { label, system_prompt: ws.system, user_prompt_template: ws.userTemplate, parent_version_id: ws.versionId } });
    setVersions((cur) => ({ ...cur, [promptId]: [v, ...(cur[promptId] ?? [])] }));
    s.patchWorkspace(promptId, { versionId: v.version_id, versionHash: v.content_hash });
  }

  async function rerender(runId: string) {
    const r = await api<{ run_id: string }>(`/api/runs/${runId}/re-render`, { method: "POST" });
    await openRun(r.run_id);
    loadRuns();
  }

  // 拖拽分隔线
  const dragging = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !container.current) return;
      const rect = container.current.getBoundingClientRect();
      s.set("editorPct", Math.min(70, Math.max(22, ((e.clientX - rect.left) / rect.width) * 100)));
    };
    const up = () => (dragging.current = false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [s]);

  const promptRuns = useMemo(() => runs.filter((r) => r.prompt_id === promptId), [runs, promptId]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900/90 px-3 py-1.5 backdrop-blur">
        <button onClick={() => s.set("sidebarCollapsed", !s.sidebarCollapsed)} className="text-ink-400 hover:text-ink-100" aria-label="折叠侧栏">
          ☰
        </button>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[13px] font-semibold tracking-tight">
            Prompt<span className="text-stamp">/</span>Studio
          </span>
          <span className="text-[12px] text-ink-400">九立 AI 核对 / {prompt?.name ?? "…"}</span>
        </div>
        {prompt?.active_schema_version && <Badge>{prompt.active_schema_version}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <span className="max-w-[460px] truncate text-[12px] text-stamp" title={error} data-testid="error-message">
              {error}
            </span>
          )}
          <Badge tone={provider?.configured ? "info" : "warn"} title={provider?.provider}>
            {provider?.configured ? provider.model : "模型未配置"}
          </Badge>
          <Btn tone="outline" onClick={renderOnly} disabled={busy} data-testid="btn-render">
            ▤ 仅渲染
          </Btn>
          <Btn tone="primary" onClick={modelRun} disabled={busy || !provider?.configured} title={provider?.configured ? "调用真实模型" : "未配置模型"} data-testid="btn-run">
            ▶ 运行模型
          </Btn>
          <Btn onClick={() => setShowCompare(true)} disabled={compare.length !== 2}>
            对比 {compare.length}/2
          </Btn>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 侧栏 */}
        {!s.sidebarCollapsed && (
          <nav className="flex w-[220px] shrink-0 flex-col border-r border-ink-700 bg-ink-900/70" data-testid="sidebar">
            <div className="px-3 pt-3 pb-1 text-[10.5px] tracking-widest text-ink-400">项目</div>
            <div className="px-3 pb-2 text-[12.5px]">九立 AI 核对</div>
            <div className="px-3 pt-2 pb-1 text-[10.5px] tracking-widest text-ink-400">提示词</div>
            <ul>
              {prompts.map((p, i) => (
                <li key={p.prompt_id} className="rise" style={{ animationDelay: `${i * 50}ms` }}>
                  <button
                    onClick={() => s.setActivePrompt(p.prompt_id)}
                    data-prompt={p.prompt_id}
                    className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800", promptId === p.prompt_id && "bg-ink-800 text-ink-100")}
                  >
                    <span className={cx("w-7 font-mono text-[11px]", promptId === p.prompt_id ? "text-stamp" : "text-ink-400")}>{SHORT[p.prompt_kind]}</span>
                    <span className="truncate">{p.name.replace(/^P\d /, "")}</span>
                    {s.workspaces[p.prompt_id]?.runId && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-verify" />}
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-3 pt-4 pb-1 text-[10.5px] tracking-widest text-ink-400">连接</div>
            <div className="px-3 text-[11.5px]">
              <div className="flex items-center gap-1.5">
                <span className={cx("h-2 w-2 rounded-full", capability?.status === "CONNECTED_DEMO_FILES" ? "bg-verify" : "bg-risk")} />
                九立 {capability?.status === "CONNECTED_DEMO_FILES" ? "Demo 文件（只读）" : "未接通"}
              </div>
              <div className="mt-0.5 text-[10.5px] text-ink-400">真实业务 API：未接通</div>
            </div>
            <div className="mt-auto border-t border-ink-700 p-2">
              <Btn className="w-full justify-center" onClick={() => s.set("historyOpen", !s.historyOpen)}>
                运行历史（{runs.length}）
              </Btn>
            </div>
          </nav>
        )}

        {/* 编辑区 | 结果区 */}
        <div ref={container} className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {!s.maximized && (
              <>
                <div className="min-w-0 border-r border-ink-700 bg-ink-900/40" style={{ width: `${s.editorPct}%` }}>
                  {prompt && (
                    <EditorPane
                      kind={prompt.prompt_kind}
                      versions={versions[promptId] ?? []}
                      fixtures={fixtures}
                      snapshots={snapshots}
                      provider={provider}
                      capability={capability}
                      onSaveVersion={saveVersion}
                      onSnapshotsChanged={loadSnapshots}
                    />
                  )}
                </div>
                <div onMouseDown={() => (dragging.current = true)} className="w-1 shrink-0 cursor-col-resize bg-ink-800 hover:bg-stamp/60" role="separator" aria-label="拖动调整宽度" />
              </>
            )}
            <div className="min-w-0 flex-1">
              <ResultPane detail={detail} dirty={dirty} canPreview={capability?.status === "CONNECTED_DEMO_FILES"} loading={busy} />
            </div>
          </div>

          {/* 底部运行历史 */}
          {s.historyOpen && (
            <div className="h-56 shrink-0 overflow-auto border-t border-ink-700 bg-ink-900" data-testid="history">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-ink-850 text-ink-400">
                  <tr>
                    {["对比", "时间", "Prompt", "模式", "状态", "标签", "模型", ""].map((h) => (
                      <th key={h} className="px-2 py-1 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(promptRuns.length ? promptRuns : runs).map((r) => (
                    <tr key={r.run_id} className={cx("border-b border-ink-800 hover:bg-ink-800/60", ws.runId === r.run_id && "bg-stamp/[0.07]")}>
                      <td className="px-2">
                        <input
                          type="checkbox"
                          aria-label={`对比 ${r.run_id}`}
                          checked={compare.includes(r.run_id)}
                          onChange={(e) => setCompare((c) => (e.target.checked ? [...c.slice(-1), r.run_id] : c.filter((x) => x !== r.run_id)))}
                        />
                      </td>
                      <td className="px-2 font-mono text-ink-400">{r.started_at.slice(5, 19).replace("T", " ")}</td>
                      <td className="px-2">{SHORT[r.prompt_kind]}</td>
                      <td className="px-2">
                        <Badge>{r.mode}</Badge>
                      </td>
                      <td className="px-2">
                        <Badge tone={RUN_STATUS_TONE[r.status]}>{RUN_STATUS_LABEL[r.status] ?? r.status}</Badge>
                      </td>
                      <td className="max-w-[320px] truncate px-2">{r.label}</td>
                      <td className="px-2 text-ink-400">{r.model_name ?? "—"}</td>
                      <td className="space-x-1 px-2 whitespace-nowrap">
                        <Btn onClick={() => openRun(r.run_id)}>回放</Btn>
                        <Btn onClick={() => rerender(r.run_id)} title="用当前 Adapter/Renderer 重新渲染（另存为新 Run，不改历史）">
                          重渲染
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {showCompare && compare.length === 2 && <RunCompare ids={compare as [string, string]} onClose={() => setShowCompare(false)} />}
    </div>
  );
}
