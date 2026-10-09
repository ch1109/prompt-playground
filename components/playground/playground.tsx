"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CapabilityDTO, FixtureSummary, PromptDef, PromptVersionDTO, ProviderInfoDTO, RunDetail, RunListItem, SnapshotListItem } from "@/lib/client/types";
import { emptyWorkspace, inputSignature, runSnapshotId, useStudio } from "@/lib/state/studio-store";
import { Badge, Btn, cx, runStatusView } from "@/components/ui";
import { EditorPane } from "./editor-pane";
import { ResultPane } from "./result-pane";
import { RunCompare } from "./run-compare";

const SHORT: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4", GENERIC_JSON: "{ }" };

/** 桌面宽度 <1280px 时编辑区/结果区改为页签切换（PRD §5.4） */
const NARROW_QUERY = "(max-width: 1279px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW_QUERY);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

interface ProjectDTO {
  project_id: string;
  name: string;
}

export function Playground({ projectId }: { projectId: string }) {
  const s = useStudio();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [newProject, setNewProject] = useState<{ name: string; template: "JIULI" | "BLANK" } | null>(null);
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
  const narrow = useNarrow();
  const [narrowPane, setNarrowPane] = useState<"editor" | "result">("editor");

  const promptId = s.activePromptId;
  const prompt = prompts.find((p) => p.prompt_id === promptId);
  const ws = s.workspaces[promptId] ?? emptyWorkspace();
  const detail = ws.runId ? s.runs[ws.runId] : undefined;
  const lastMode = s.lastMode[promptId];
  const dirty = !!detail && !!ws.runInputSig && !!lastMode && inputSignature(ws, lastMode) !== ws.runInputSig;

  // 挂载后恢复本地保存的工作区（刷新不丢）
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    Promise.resolve(useStudio.persist.rehydrate()).then(() => setHydrated(true));
  }, []);

  // 当前选中的 Prompt 不属于本项目（例如刚切换项目）→ 选本项目第一个
  useEffect(() => {
    if (hydrated && prompts.length && !prompts.some((p) => p.prompt_id === promptId)) s.setActivePrompt(prompts[0].prompt_id);
  }, [hydrated, prompts, promptId, s]);

  async function createProject() {
    if (!newProject?.name.trim()) return setError("请填写项目名称");
    setError(null);
    try {
      const p = await api<ProjectDTO>("/api/projects", { json: newProject });
      setNewProject(null);
      router.push(`/projects/${encodeURIComponent(p.project_id)}/playground`);
    } catch (e) {
      report(e);
    }
  }

  // 当前 Run 详情不在内存时按 ID 重新读取；Run 已不存在则清掉引用
  const runId = ws.runId;
  const cached = !!(runId && s.runs[runId]);
  useEffect(() => {
    if (!hydrated || !runId || cached) return;
    api<RunDetail>(`/api/runs/${runId}`)
      .then(s.putRun)
      .catch(() => s.patchWorkspace(promptId, { runId: null, runInputSig: null }));
  }, [hydrated, runId, cached, promptId, s]);

  // 历史只查当前 Prompt，分批加载（每批 100 条），避免旧记录被截断后看不到
  const RUN_PAGE = 100;
  const [runLimit, setRunLimit] = useState(RUN_PAGE);
  useEffect(() => setRunLimit(RUN_PAGE), [promptId]);
  const loadRuns = useCallback(
    () => api<RunListItem[]>(`/api/runs?project=${projectId}&promptId=${encodeURIComponent(promptId)}&limit=${runLimit}`).then(setRuns),
    [projectId, promptId, runLimit],
  );
  const moreRuns = runs.length >= runLimit;
  // 打开的 Run 仍在运行（例如刷新前发起）：轮询直到结束后自动显示结果
  const runningRunId = detail?.run.status === "RUNNING" ? detail.run.run_id : null;
  useEffect(() => {
    if (!runningRunId) return;
    const t = setInterval(() => {
      api<RunDetail>(`/api/runs/${runningRunId}`)
        .then((d) => {
          if (d.run.status === "RUNNING") return;
          s.putRun(d);
          loadRuns();
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [runningRunId, s, loadRuns]);

  // 历史中有运行中的记录（可能来自其他窗口或刷新前）：定时刷新，状态不停在「运行中」
  const anyRunning = runs.some((r) => r.status === "RUNNING");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(loadRuns, 3000);
    return () => clearInterval(t);
  }, [anyRunning, loadRuns]);

  const SNAPSHOT_PAGE = 50;
  const [snapshotLimit, setSnapshotLimit] = useState(SNAPSHOT_PAGE);
  const loadSnapshots = useCallback(() => api<SnapshotListItem[]>(`/api/snapshots?project=${projectId}&limit=${snapshotLimit}`).then(setSnapshots), [projectId, snapshotLimit]);

  useEffect(() => {
    api<ProjectDTO[]>("/api/projects").then(setProjects).catch((e) => setError(e.message));
    api<PromptDef[]>(`/api/prompts?project=${projectId}`)
      .then((p) => {
        setPrompts(p);
        setPromptsLoaded(true);
      })
      .catch((e) => setError(e.message));
    api<{ items: FixtureSummary[] }>("/api/fixtures").then((r) => setFixtures(r.items));
    api<ProviderInfoDTO>("/api/models").then(setProvider);
    api<CapabilityDTO>("/api/connectors/jiuli/capabilities").then(setCapability).catch(() => setCapability(null));
  }, [projectId]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

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
      setNarrowPane("result");
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

  /** 带请求上下文的样本 → 创建（或复用同内容的）快照；没有上下文返回 null */
  async function fixtureSnapshot(fixtureId: string): Promise<string | null> {
    if (!fixtures.find((f) => f.id === fixtureId)?.hasRequest) return null;
    const snap = await api<{ snapshot_id: string }>("/api/snapshots/import", { json: { projectId, fixtureId } });
    return snap.snapshot_id;
  }

  /** 选中样本时立即准备快照，让请求预览在运行前就显示实际要发送的内容 */
  async function pickFixture(fixtureId: string, pid = promptId) {
    s.patchWorkspace(pid, { fixtureId, fixtureSnapshotId: null });
    try {
      const id = await fixtureSnapshot(fixtureId);
      // 期间用户又换了样本，就不覆盖
      if (useStudio.getState().workspaces[pid]?.fixtureId === fixtureId) s.patchWorkspace(pid, { fixtureSnapshotId: id });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    }
  }

  // 恢复后重新确认样本快照（本地记录的快照 ID 可能因清空数据库而失效；同内容会复用）
  const fixturesRechecked = useRef(false);
  useEffect(() => {
    if (!hydrated || !fixtures.length || fixturesRechecked.current) return;
    fixturesRechecked.current = true;
    for (const [pid, w] of Object.entries(useStudio.getState().workspaces)) if (w.inputMode === "fixture" && w.fixtureId) pickFixture(w.fixtureId, pid);
  });

  async function modelRun() {
    setError(null);
    setBusy(true);
    setNarrowPane("result");
    try {
      // 与请求预览同一来源（runSnapshotId）；样本快照尚未就绪时在此补建
      let w = ws;
      if (w.inputMode === "fixture") {
        if (!w.fixtureId) throw new Error("请选择样本");
        if (!w.fixtureSnapshotId) {
          w = { ...w, fixtureSnapshotId: await fixtureSnapshot(w.fixtureId) };
          s.patchWorkspace(promptId, { fixtureSnapshotId: w.fixtureSnapshotId });
        }
        if (!w.fixtureSnapshotId) throw new Error("该样本没有请求上下文，不能真实运行，只能「仅渲染」");
      }
      const snapshotId = runSnapshotId(w);
      if (!snapshotId) throw new Error("真实运行必须选择输入快照（带 ctx 的样本、已有快照，或从九立只读导入）；粘贴的 JSON 只能「仅渲染」");
      const run = await api<{ run_id: string }>("/api/runs", {
        json: { mode: "MODEL_RUN", projectId, promptId, snapshotId, system: w.system, userTemplate: w.userTemplate, promptVersionId: w.versionId, params: w.params, attachImages: w.attachImages },
      });
      // 服务端登记 RUNNING 后立即返回：先打开这条 Run（ID 存入工作区，刷新也能接上），结果由轮询自动显示
      await openRun(run.run_id, { sig: inputSignature(w, "MODEL_RUN"), mode: "MODEL_RUN" });
      loadRuns();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const report = (e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

  /** 返回是否保存成功；失败时在顶栏显示错误 */
  async function saveVersion(label: string): Promise<boolean> {
    setError(null);
    try {
      const v = await api<PromptVersionDTO>(`/api/prompts/${promptId}/versions`, { json: { label, system_prompt: ws.system, user_prompt_template: ws.userTemplate, parent_version_id: ws.versionId } });
      setVersions((cur) => ({ ...cur, [promptId]: [v, ...(cur[promptId] ?? [])] }));
      s.patchWorkspace(promptId, { versionId: v.version_id, versionHash: v.content_hash });
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  }

  async function rerender(runId: string) {
    setError(null);
    try {
      const r = await api<{ run_id: string }>(`/api/runs/${runId}/re-render`, { method: "POST" });
      await openRun(r.run_id);
      loadRuns();
    } catch (e) {
      report(e);
    }
  }

  async function replay(runId: string) {
    setError(null);
    try {
      await openRun(runId);
    } catch (e) {
      report(e);
    }
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
          <span className="text-[12px] text-ink-400">
            {projects?.find((p) => p.project_id === projectId)?.name ?? "…"} / {prompt?.name ?? "…"}
          </span>
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
          <Btn
            tone="primary"
            onClick={modelRun}
            disabled={busy || !provider?.configured || runningRunId !== null}
            title={!provider?.configured ? "未配置模型" : runningRunId ? "当前 Prompt 的上一次运行尚未结束" : "调用真实模型"}
            data-testid="btn-run"
          >
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
            <div className="space-y-1 px-3 pb-2">
              <select
                value={projectId}
                onChange={(e) => router.push(`/projects/${encodeURIComponent(e.target.value)}/playground`)}
                aria-label="切换项目"
                className="w-full rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-[12.5px]"
              >
                {!projects?.some((p) => p.project_id === projectId) && <option value={projectId}>{projects ? "（项目不存在）" : "…"}</option>}
                {projects?.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {newProject ? (
                <div className="space-y-1 rounded border border-ink-700 p-1.5" data-testid="new-project-form">
                  <input
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                    placeholder="项目名称"
                    aria-label="项目名称"
                    className="w-full rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 text-[12px]"
                  />
                  <select
                    value={newProject.template}
                    onChange={(e) => setNewProject({ ...newProject, template: e.target.value as "JIULI" | "BLANK" })}
                    aria-label="项目模板"
                    className="w-full rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-[12px]"
                  >
                    <option value="JIULI">复制九立 P1~P4 提示词</option>
                    <option value="BLANK">空白（通用 JSON）</option>
                  </select>
                  <div className="flex gap-1">
                    <Btn tone="primary" onClick={createProject}>
                      创建
                    </Btn>
                    <Btn onClick={() => setNewProject(null)}>取消</Btn>
                  </div>
                </div>
              ) : (
                <button onClick={() => setNewProject({ name: "", template: "JIULI" })} className="text-[11.5px] text-info hover:underline">
                  ＋ 新建项目
                </button>
              )}
            </div>
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
                运行历史（{runs.length}
                {moreRuns ? "+" : ""}）
              </Btn>
            </div>
          </nav>
        )}

        {/* 编辑区 | 结果区 */}
        <div ref={container} className="flex min-w-0 flex-1 flex-col">
          {narrow && (
            <div className="flex border-b border-ink-700 bg-ink-900 text-[12.5px]" data-testid="narrow-tabs">
              {(
                [
                  ["editor", "编辑"],
                  ["result", "结果"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} onClick={() => setNarrowPane(id)} aria-pressed={narrowPane === id} className={cx("flex-1 py-1.5", narrowPane === id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-100")}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {(narrow ? narrowPane === "editor" : !s.maximized) && (
              <>
                <div className="min-w-0 border-r border-ink-700 bg-ink-900/40" style={{ width: narrow ? "100%" : `${s.editorPct}%` }}>
                  {prompt && (
                    <EditorPane
                      kind={prompt.prompt_kind}
                      versions={versions[promptId] ?? []}
                      fixtures={fixtures}
                      snapshots={snapshots}
                      provider={provider}
                      capability={capability}
                      onSaveVersion={saveVersion}
                      onPickFixture={pickFixture}
                      onSnapshotsChanged={loadSnapshots}
                      onMoreSnapshots={snapshots.length >= snapshotLimit ? () => setSnapshotLimit((n) => n + SNAPSHOT_PAGE) : undefined}
                      projectId={projectId}
                    />
                  )}
                </div>
                {!narrow && <div onMouseDown={() => (dragging.current = true)} className="w-1 shrink-0 cursor-col-resize bg-ink-800 hover:bg-stamp/60" role="separator" aria-label="拖动调整宽度" />}
              </>
            )}
            {(!narrow || narrowPane === "result") && (
              <div className="min-w-0 flex-1">
                {promptsLoaded && !prompts.length ? (
                  <p className="p-4 text-[12.5px] text-risk" data-testid="project-missing">
                    该项目不存在或没有提示词。请在左侧切换或新建项目。
                  </p>
                ) : (
                  <ResultPane detail={detail} dirty={dirty} canPreview={capability?.status === "CONNECTED_DEMO_FILES"} loading={busy} />
                )}
              </div>
            )}
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
                  {!runs.length && (
                    <tr>
                      <td colSpan={8} className="px-3 py-4 text-ink-400">
                        当前 Prompt 还没有运行记录。
                      </td>
                    </tr>
                  )}
                  {runs.map((r) => (
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
                        <Badge tone={runStatusView(r.status, r.schema_id).tone}>{runStatusView(r.status, r.schema_id).label}</Badge>
                      </td>
                      <td className="max-w-[320px] truncate px-2">{r.label}</td>
                      <td className="px-2 text-ink-400">{r.model_name ?? "—"}</td>
                      <td className="space-x-1 px-2 whitespace-nowrap">
                        <Btn onClick={() => replay(r.run_id)}>回放</Btn>
                        <Btn onClick={() => rerender(r.run_id)} title="用当前 Adapter/Renderer 重新渲染（另存为新 Run，不改历史）">
                          重渲染
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {moreRuns && (
                <div className="p-2 text-center">
                  <Btn onClick={() => setRunLimit((n) => n + RUN_PAGE)}>加载更多（已显示最近 {runs.length} 条）</Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {showCompare && compare.length === 2 && <RunCompare ids={compare as [string, string]} onClose={() => setShowCompare(false)} />}
    </div>
  );
}
