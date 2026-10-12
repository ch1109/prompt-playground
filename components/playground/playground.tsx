"use client";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CapabilityDTO, FixtureSummary, PromptDef, PromptVersionDTO, ProviderInfoDTO, RunDetail, RunListItem, SnapshotListItem } from "@/lib/client/types";
import type { PromptKind } from "@/lib/contracts/run";
import { emptyWorkspace, inputSignature, runSnapshotId, useStudio, type WorkMode } from "@/lib/state/studio-store";
import { Badge, Btn, cx, Empty, runStatusView } from "@/components/ui";
import { EditorPane, InputTab } from "./editor-pane";
import { ResultPane } from "./result-pane";
import { RunCompare } from "./run-compare";
import { GuideDialog } from "./guide-dialog";

const GUIDE_SEEN_KEY = "prompt-studio-guide-seen";

const SHORT: Record<string, string> = { JIULI_P1: "P1", JIULI_P2: "P2", JIULI_P3: "P3", JIULI_P4: "P4", GENERIC_JSON: "通用" };

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
  archived_at?: string | null;
}

const MODES: [WorkMode, string, string][] = [
  ["check", "结果检查", "结果占满屏幕，看哪里错了"],
  ["debug", "提示词调试", "左边改提示词和输入，右边看结果"],
  ["compare", "版本对比", "选两次运行，看差在哪"],
];

const FIXTURE_ORIGIN = { STRUCTURE_EXAMPLE: "格式示例", RECORDED_MODEL_OUTPUT: "真实录制 · 非标准答案", CONSTRUCTED: "人工构造" } as const;
const SOURCE_LABEL: Record<string, string> = { FILE_IMPORT: "上传文件", JIULI_READONLY: "九立导入", FIXTURE: "示例", JSON_IMPORT: "粘贴导入" };

const NEW_PROMPT_KINDS: [PromptKind, string][] = [
  ["GENERIC_JSON", "通用提示词"],
  ["JIULI_P1", "P1 委托材料识别"],
  ["JIULI_P2", "P2 查货材料识别"],
  ["JIULI_P3", "P3 商品对应关系"],
  ["JIULI_P4", "P4 字段核验"],
];

export function Playground({ projectId }: { projectId: string }) {
  const s = useStudio();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [newProject, setNewProject] = useState<{ name: string; template: "JIULI" | "BLANK" } | null>(null);
  /** 正在编辑的项目名称（改名表单） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState<{ name: string; kind: PromptKind } | null>(null);
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
  const [showGuide, setShowGuide] = useState(false);
  // 第一次打开自动弹出新手指南；读写失败（隐私模式等）就不弹，不影响使用
  useEffect(() => {
    try {
      if (!localStorage.getItem(GUIDE_SEEN_KEY)) setShowGuide(true);
    } catch {
      /* 忽略：无法读取时不自动弹出 */
    }
  }, []);
  const closeGuide = () => {
    setShowGuide(false);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch {
      /* 忽略 */
    }
  };
  const narrow = useNarrow();
  const [narrowPane, setNarrowPane] = useState<"editor" | "result">("editor");
  /** 结果检查模式下的「更换输入」抽屉 */
  const [inputDrawer, setInputDrawer] = useState(false);
  // 窄屏沿用「编辑 / 结果」页签；三种工作模式只在宽屏生效
  const mode: WorkMode = narrow ? "debug" : s.workMode;

  const promptId = s.activePromptId;
  const prompt = prompts.find((p) => p.prompt_id === promptId);
  const ws = s.workspaces[promptId] ?? emptyWorkspace();
  const detail = ws.runId ? s.runs[ws.runId] : undefined;
  const lastMode = s.lastMode[promptId];
  const hasFixtures = !!prompt && fixtures.some((f) => f.promptKind === prompt.prompt_kind);
  // 空状态示例：优先带请求上下文的人工构造样本（覆盖异常场景），其次录制样本
  const kindFixtures = prompt ? fixtures.filter((f) => f.promptKind === prompt.prompt_kind) : [];
  const exampleFixture = kindFixtures.find((f) => f.origin === "CONSTRUCTED" && f.hasRequest && f.schemaVersion) ?? kindFixtures.find((f) => f.origin === "RECORDED_MODEL_OUTPUT") ?? kindFixtures[0];
  const emptyHint =
    (hasFixtures
      ? "在「输入」上传文件后点「运行模型」；也可以在「示例」里选一个示例，点「仅渲染」直接看结果。"
      : "在「输入」上传文件（可以是整个文件夹）后点「运行模型」；也可以在「更多 → 粘贴 JSON」粘贴模型输出后点「仅渲染」。") +
    (provider && !provider.configured ? "（模型未配置，目前只能仅渲染）" : "");
  /** 顶栏显示的当前版本；文本与该版本不同即为未保存草稿（与「提示词」页签的判断一致） */
  const currentVersion = versions[promptId]?.find((v) => v.version_id === ws.versionId);
  const versionDraft = !!currentVersion && (currentVersion.system_prompt !== ws.system || currentVersion.user_prompt_template !== ws.userTemplate);
  const dirty = !!detail && !!ws.runInputSig && !!lastMode && inputSignature(ws, lastMode) !== ws.runInputSig;

  // 挂载后恢复本地保存的工作区（刷新不丢）
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    Promise.resolve(useStudio.persist.rehydrate()).then(() => setHydrated(true));
  }, []);

  const loadProjects = useCallback(() => api<ProjectDTO[]>("/api/projects").then(setProjects).catch((e) => setError(e.message)), []);
  const loadPrompts = useCallback(
    () =>
      api<PromptDef[]>(`/api/prompts?project=${projectId}`)
        .then((p) => {
          setPrompts(p);
          setPromptsLoaded(true);
          return p;
        })
        .catch((e) => {
          setError(e.message);
          return [] as PromptDef[];
        }),
    [projectId],
  );
  const project = projects?.find((p) => p.project_id === projectId);

  async function updateProject(patch: { name?: string; archived?: boolean }) {
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", json: patch });
      setRenaming(null);
      await loadProjects();
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  }

  async function archiveProject() {
    if (!window.confirm(`归档项目「${project?.name}」？\n\n归档后它移到下拉框的「已归档」分组，运行记录、输入、标注全部保留，可随时恢复。`)) return;
    if (await updateProject({ archived: true })) router.push("/projects/jiuli/playground");
  }

  async function createPrompt() {
    if (!newPrompt?.name.trim()) return setError("请填写提示词名称");
    setError(null);
    try {
      const p = await api<PromptDef>("/api/prompts", { json: { projectId, ...newPrompt } });
      setNewPrompt(null);
      await loadPrompts();
      s.setActivePrompt(p.prompt_id);
    } catch (e) {
      report(e);
    }
  }

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
  // 切换提示词后，较慢返回的旧请求不能覆盖当前提示词的历史：只采用最新一次请求的结果
  const runsRequest = useRef("");
  const loadRuns = useCallback(() => {
    const url = `/api/runs?project=${projectId}&promptId=${encodeURIComponent(promptId)}&limit=${runLimit}`;
    runsRequest.current = url;
    return api<RunListItem[]>(url).then((list) => {
      if (runsRequest.current === url) setRuns(list);
    });
  }, [projectId, promptId, runLimit]);
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
    loadProjects();
    loadPrompts();
    api<ProviderInfoDTO>("/api/models").then(setProvider);
    api<CapabilityDTO>("/api/connectors/jiuli/capabilities").then(setCapability).catch(() => setCapability(null));
  }, [loadProjects, loadPrompts]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  // 样本列表带本项目的运行统计；运行记录变化后刷新
  useEffect(() => {
    api<{ items: FixtureSummary[] }>(`/api/fixtures?project=${projectId}`).then((r) => setFixtures(r.items));
  }, [projectId, runs.length]);
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
      if (!cur?.versionId && latest) {
        // 加载完成前用户已经开始输入：保留输入（显示为基于最新版本的未保存草稿），不覆盖
        const typed = !!cur?.system;
        s.patchWorkspace(promptId, typed ? { versionId: latest.version_id, versionHash: latest.content_hash } : { versionId: latest.version_id, versionHash: latest.content_hash, system: latest.system_prompt, userTemplate: latest.user_prompt_template });
      }
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
        if (!ws.fixtureId) throw new Error("请先在「输入 → 示例」选择一个示例");
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
        throw new Error("「仅渲染」需要示例或粘贴的 JSON；上传的文件请用「运行模型」");
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
        if (!w.fixtureId) throw new Error("请选择示例");
        if (!w.fixtureSnapshotId) {
          w = { ...w, fixtureSnapshotId: await fixtureSnapshot(w.fixtureId) };
          s.patchWorkspace(promptId, { fixtureSnapshotId: w.fixtureSnapshotId });
        }
        if (!w.fixtureSnapshotId) throw new Error("这个示例没有附带输入，不能真实运行，只能「仅渲染」");
      }
      const snapshotId = runSnapshotId(w);
      if (!snapshotId) throw new Error("真实运行必须选择输入快照（带 ctx 的样本、已有快照，或从九立只读导入）；粘贴的请求可先点「请求存为快照」");
      const run = await api<{ run_id: string }>("/api/runs", {
        json: { mode: "MODEL_RUN", projectId, promptId, snapshotId, system: w.system, userTemplate: w.userTemplate, promptVersionId: w.versionId, params: w.params, attachImages: w.attachImages ?? undefined },
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
  async function saveVersion(label: string, changeNote: string): Promise<boolean> {
    setError(null);
    try {
      const v = await api<PromptVersionDTO>(`/api/prompts/${promptId}/versions`, { json: { label, change_note: changeNote, system_prompt: ws.system, user_prompt_template: ws.userTemplate, parent_version_id: ws.versionId } });
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

  /** 空状态里的「打开示例」：仅渲染一个样本（Fixture），结果明确标为样本，不是本次运行 */
  async function openExample(fixtureId: string) {
    setError(null);
    setBusy(true);
    try {
      await pickFixture(fixtureId);
      s.patchWorkspace(promptId, { inputMode: "fixture" });
      const run = await api<{ run_id: string }>("/api/runs", { json: { mode: "RENDER_ONLY", projectId, promptId, fixtureId } });
      await openRun(run.run_id, { sig: inputSignature({ ...useStudio.getState().workspaces[promptId], inputMode: "fixture", fixtureId }, "RENDER_ONLY"), mode: "RENDER_ONLY" });
      loadRuns();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }

  async function retryRun(runId: string) {
    setError(null);
    try {
      const r = await api<{ run_id: string }>(`/api/runs/${runId}/retry`, { method: "POST" });
      await openRun(r.run_id);
      loadRuns();
    } catch (e) {
      report(e);
    }
  }

  async function cancelRun(runId: string) {
    setError(null);
    try {
      await api(`/api/runs/${runId}/cancel`, { method: "POST" });
      // 轮询会在 Run 落到 CANCELLED 后自动刷新结果区与历史
    } catch (e) {
      report(e);
    }
  }

  /**
   * 切换 Prompt：目标 Prompt 还没选输入时，若当前使用的快照（已有快照 / 上传）也适用于它，就一并带过去；
   * 已有选择的不覆盖。
   */
  function switchPrompt(id: string) {
    const snap = ws.inputMode === "snapshot" || ws.inputMode === "upload" ? runSnapshotId(ws) : null;
    const target = useStudio.getState().workspaces[id];
    const untouched = !target || (target.inputMode === "fixture" && !target.fixtureId);
    const kind = prompts.find((p) => p.prompt_id === id)?.prompt_kind;
    s.setActivePrompt(id);
    if (snap && untouched && kind && snapshots.find((x) => x.snapshot_id === snap)?.usable_kinds.includes(kind)) {
      s.patchWorkspace(id, { inputMode: "snapshot", snapshotId: snap });
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

  /** 运行历史表（底部面板与「版本对比」模式共用） */
  const historyTable = (
    <>
      <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 z-10 bg-ink-900/95 text-[11.5px] text-ink-400 backdrop-blur">
                  <tr className="border-b border-ink-700">
                    {["对比", "时间", "Prompt", "模式", "状态", "标签", "模型", ""].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!runs.length && (
                    <tr>
                      <td colSpan={8} className="px-3 py-5 text-ink-400">
                        当前 Prompt 还没有运行记录。
                      </td>
                    </tr>
                  )}
                  {runs.map((r) => (
                    <tr key={r.run_id} className={cx("border-b border-ink-800 hover:bg-ink-850", ws.runId === r.run_id && "bg-accent/[0.06]")}>
                      <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={`对比 ${r.run_id}`}
                          checked={compare.includes(r.run_id)}
                          onChange={(e) => setCompare((c) => (e.target.checked ? [...c.slice(-1), r.run_id] : c.filter((x) => x !== r.run_id)))}
                          className="accent-ink-100"
                        />
                      </td>
                      <td className="px-3 font-mono text-[11.5px] text-ink-400">{r.started_at.slice(5, 19).replace("T", " ")}</td>
                      <td className="px-3 font-mono text-[11.5px]">{SHORT[r.prompt_kind]}</td>
                      <td className="px-3">
                        <Badge>{r.mode}</Badge>
                      </td>
                      <td className="px-3">
                        <Badge tone={runStatusView(r.status, r.schema_id, r.prompt_kind, r.mode).tone}>{runStatusView(r.status, r.schema_id, r.prompt_kind, r.mode).label}</Badge>
                      </td>
                      <td className="max-w-[320px] truncate px-3">{r.label}</td>
                      <td className="px-3 text-ink-400">{r.model_name ?? "—"}</td>
                      <td className="space-x-1 px-3 py-1 whitespace-nowrap">
                        <Btn onClick={() => replay(r.run_id)}>回放</Btn>
                        <Btn onClick={() => rerender(r.run_id)} title="用当前的显示规则重新整理这次结果（另存为新记录，不改历史）">
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
    </>
  );
  const moreSnapshots = snapshots.length >= snapshotLimit ? () => setSnapshotLimit((n) => n + SNAPSHOT_PAGE) : undefined;

  /** 结果检查模式顶部：当前输入（名称 / 来源 / Gold）、提示词版本、模型，与三个常用动作 */
  function contextBar() {
    const fx = ws.inputMode === "fixture" ? fixtures.find((f) => f.id === ws.fixtureId) : undefined;
    const snap = snapshots.find((x) => x.snapshot_id === runSnapshotId(ws));
    const name = fx?.title ?? (ws.inputMode === "paste" ? "粘贴的 JSON" : snap?.label) ?? "还没选输入";
    const source = fx ? FIXTURE_ORIGIN[fx.origin] : ws.inputMode === "paste" ? "粘贴" : snap ? (SOURCE_LABEL[snap.source_type] ?? snap.source_type) : null;
    const gold = fx ? fx.hasGold : null;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-ink-700 bg-ink-900 px-4 py-2 text-[12.5px]" data-testid="context-bar">
        <span className="text-ink-400">当前输入</span>
        <span className="max-w-[360px] truncate font-semibold text-ink-100" title={name}>
          {name}
        </span>
        {source && <Badge tone="info">{source}</Badge>}
        {gold !== null && <Badge tone={gold ? "ok" : "mute"}>{gold ? "有标准答案" : "无标准答案"}</Badge>}
        <Btn onClick={() => setInputDrawer(true)} data-testid="btn-change-input">
          更换输入
        </Btn>
        <span className="ml-auto text-ink-400">
          提示词 {currentVersion?.label ?? "—"}
          {versionDraft ? "（未保存草稿）" : ""} · {provider?.configured ? provider.model : "模型未配置"}
        </span>
        <Btn onClick={() => s.set("workMode", "debug")} data-testid="btn-edit-prompt">
          编辑提示词
        </Btn>
      </div>
    );
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


  const field = "w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 text-[12.5px] outline-none focus:border-ink-400";

  return (
    <div className="flex h-screen gap-2 overflow-hidden p-2">
      {/* 侧栏 */}
      {!s.sidebarCollapsed && (
        <nav className="flex w-[244px] shrink-0 flex-col" data-testid="sidebar">
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-4">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-ink-100 font-mono text-[11px] font-semibold text-white">P/</span>
            <span className="text-[14px] font-semibold tracking-tight">Prompt Studio</span>
            <button onClick={() => s.set("sidebarCollapsed", true)} className="ml-auto rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="折叠侧栏" title="折叠侧栏">
              <Icon d={ICONS.sidebar} />
            </button>
          </div>

          <SideLabel>项目</SideLabel>
          <div className="space-y-1.5 px-1 pb-3">
            <select
              value={projectId}
              onChange={(e) => router.push(`/projects/${encodeURIComponent(e.target.value)}/playground`)}
              aria-label="切换项目"
              className={cx(field, "cursor-pointer font-medium shadow-[0_1px_2px_rgb(0_0_0/0.04)]")}
            >
              {!projects?.some((p) => p.project_id === projectId) && <option value={projectId}>{projects ? "（项目不存在）" : "…"}</option>}
              {projects
                ?.filter((p) => !p.archived_at)
                .map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              {projects?.some((p) => p.archived_at) && (
                <optgroup label="已归档">
                  {projects
                    .filter((p) => p.archived_at)
                    .map((p) => (
                      <option key={p.project_id} value={p.project_id}>
                        {p.name}（已归档）
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
            {project?.archived_at && (
              <div className="flex items-center gap-1 rounded-lg border border-risk/25 bg-risk/[0.08] px-2 py-1.5 text-[11.5px] text-risk" data-testid="project-archived">
                此项目已归档
                <button onClick={() => updateProject({ archived: false })} className="ml-auto font-medium text-accent hover:underline">
                  恢复
                </button>
              </div>
            )}
            {renaming !== null && (
              <div className="space-y-1.5 rounded-xl border border-ink-700 bg-ink-900 p-2 shadow-sm" data-testid="rename-project-form">
                <input value={renaming} onChange={(e) => setRenaming(e.target.value)} aria-label="新项目名称" className={field} />
                <div className="flex gap-1">
                  <Btn tone="primary" onClick={() => updateProject({ name: renaming })}>
                    保存
                  </Btn>
                  <Btn onClick={() => setRenaming(null)}>取消</Btn>
                </div>
              </div>
            )}
            {newProject ? (
              <div className="space-y-1.5 rounded-xl border border-ink-700 bg-ink-900 p-2 shadow-sm" data-testid="new-project-form">
                <input value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} placeholder="项目名称" aria-label="项目名称" className={field} />
                <select value={newProject.template} onChange={(e) => setNewProject({ ...newProject, template: e.target.value as "JIULI" | "BLANK" })} aria-label="项目模板" className={field}>
                  <option value="JIULI">复制九立 P1~P4 提示词</option>
                  <option value="BLANK">空白（只有通用提示词）</option>
                </select>
                <div className="flex gap-1">
                  <Btn tone="primary" onClick={createProject}>
                    创建
                  </Btn>
                  <Btn onClick={() => setNewProject(null)}>取消</Btn>
                </div>
              </div>
            ) : (
              <div className="flex gap-0.5 text-[12px]">
                <button onClick={() => setNewProject({ name: "", template: "JIULI" })} className="rounded-md px-1.5 py-0.5 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
                  ＋ 新建项目
                </button>
                {project && (
                  <button onClick={() => setRenaming(project.name)} className="rounded-md px-1.5 py-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
                    改名
                  </button>
                )}
                {project && !project.archived_at && projectId !== "jiuli" && (
                  <button onClick={archiveProject} className="rounded-md px-1.5 py-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
                    归档
                  </button>
                )}
              </div>
            )}
          </div>

          <SideLabel
            right={
              project &&
              !newPrompt && (
                <button onClick={() => setNewPrompt({ name: "", kind: "GENERIC_JSON" })} className="rounded-md p-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="新建提示词" title="在本项目新建提示词">
                  <Icon d={ICONS.plus} />
                </button>
              )
            }
          >
            提示词
          </SideLabel>
          {newPrompt && (
            <div className="mx-1 mb-1.5 space-y-1.5 rounded-xl border border-ink-700 bg-ink-900 p-2 shadow-sm" data-testid="new-prompt-form">
              <input value={newPrompt.name} onChange={(e) => setNewPrompt({ ...newPrompt, name: e.target.value })} placeholder="提示词名称" aria-label="提示词名称" className={field} />
              <select value={newPrompt.kind} onChange={(e) => setNewPrompt({ ...newPrompt, kind: e.target.value as PromptKind })} aria-label="提示词种类" className={field}>
                {NEW_PROMPT_KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-ink-400">{newPrompt.kind === "GENERIC_JSON" ? "任意提示词 + 任意文件；模型回答 JSON 时按树展示，回答文字时按文本展示。" : "以九立项目同种类的最新版本为起点。"}</p>
              <div className="flex gap-1">
                <Btn tone="primary" onClick={createPrompt}>
                  创建
                </Btn>
                <Btn onClick={() => setNewPrompt(null)}>取消</Btn>
              </div>
            </div>
          )}
          <ul className="min-h-0 space-y-0.5 overflow-auto px-1">
            {prompts.map((p, i) => {
              const active = promptId === p.prompt_id;
              const groupStart = p.prompt_kind !== "GENERIC_JSON" && (i === 0 || prompts[i - 1].prompt_kind === "GENERIC_JSON");
              return (
                <li key={p.prompt_id} className="rise" style={{ animationDelay: `${i * 40}ms` }}>
                  {groupStart && <div className="px-2 pb-0.5 pt-2 text-[11px] text-ink-400">九立预设</div>}
                  <button
                    onClick={() => switchPrompt(p.prompt_id)}
                    data-prompt={p.prompt_id}
                    aria-current={active || undefined}
                    className={cx(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[13px] transition-colors",
                      active ? "bg-ink-900 font-medium text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_0_0_1px_var(--color-ink-700)]" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
                    )}
                  >
                    <span className={cx("grid h-5 w-7 shrink-0 place-items-center rounded-md font-mono text-[10.5px]", active ? "bg-ink-100 text-white" : "bg-ink-800 text-ink-400")}>{SHORT[p.prompt_kind]}</span>
                    <span className="truncate">{p.name.replace(/^P\d /, "")}</span>
                    {s.workspaces[p.prompt_id]?.runId && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-verify" title="有已打开的运行结果" />}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-auto space-y-1.5 px-1 pt-3">
            <div className="rounded-xl border border-ink-700 bg-ink-900/70 px-2.5 py-2 text-[12px]">
              <div className="flex items-center gap-1.5 font-medium">
                <span className={cx("h-1.5 w-1.5 rounded-full", capability?.status === "CONNECTED_DEMO_FILES" ? "bg-verify" : "bg-risk")} />
                九立 {capability?.status === "CONNECTED_DEMO_FILES" ? "Demo 文件（只读）" : "未接通"}
              </div>
              <div className="mt-0.5 pl-3 text-[11px] text-ink-400">真实业务 API：未接通</div>
            </div>
            <button
              onClick={() => s.set("historyOpen", !s.historyOpen)}
              aria-pressed={s.historyOpen}
              className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[13px]", s.historyOpen ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100")}
            >
              <Icon d={ICONS.history} />
              运行历史（{runs.length}
              {moreRuns ? "+" : ""}）
            </button>
          </div>
        </nav>
      )}

      {/* 主区：顶栏 + 编辑区 | 结果区 + 运行历史 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-[0_1px_3px_rgb(0_0_0/0.05),0_8px_24px_-12px_rgb(0_0_0/0.08)]">
        <header className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5">
          {s.sidebarCollapsed && (
            <button onClick={() => s.set("sidebarCollapsed", false)} className="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="展开侧栏" title="展开侧栏">
              <Icon d={ICONS.sidebar} />
            </button>
          )}
          <div className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            <span className="truncate text-ink-400">{projects?.find((p) => p.project_id === projectId)?.name ?? "…"}</span>
            <span className="text-ink-600">/</span>
            <span className="truncate font-semibold">{prompt?.name ?? "…"}</span>
          </div>
          {currentVersion && (
            <span className="flex min-w-0 items-center gap-1" data-testid="header-version" title={`当前版本：${currentVersion.label}`}>
              <Badge tone="mute" className="max-w-[180px] truncate">
                版本 {currentVersion.label}
              </Badge>
              {versionDraft && <Badge tone="warn">未保存草稿</Badge>}
            </span>
          )}
          {!narrow && (
            <div className="flex gap-0.5 rounded-xl bg-ink-800 p-1 text-[12.5px]" role="tablist" aria-label="工作模式" data-testid="work-modes">
              {MODES.map(([id, label, hint]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={mode === id}
                  title={hint}
                  onClick={() => s.set("workMode", id)}
                  className={cx("whitespace-nowrap rounded-lg px-2.5 py-0.5 transition-colors", mode === id ? "bg-ink-900 font-medium text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink-400 hover:text-ink-100")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {error && (
              <span className="max-w-[420px] truncate rounded-lg bg-stamp-soft px-2 py-1 text-[12px] text-stamp" title={error} data-testid="error-message">
                {error}
              </span>
            )}
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-ink-700 px-2.5 py-1 font-mono text-[11px] text-ink-300" title={provider?.provider}>
              <span className={cx("h-1.5 w-1.5 rounded-full", provider?.configured ? "bg-verify" : "bg-risk")} />
              {provider?.configured ? provider.model : "模型未配置"}
            </span>
            <Btn onClick={() => setShowGuide(true)} title="查看三步上手说明和名词解释" data-testid="btn-guide">
              新手指南
            </Btn>
            <Btn onClick={() => s.set("workMode", "compare")} disabled={compare.length !== 2} title="在运行历史中勾选两条记录后对比">
              对比 {compare.length}/2
            </Btn>
            <Btn tone="outline" onClick={renderOnly} disabled={busy} data-testid="btn-render" title="离线整理已有输出为表格，不调用模型，不花钱">
              <Icon d={ICONS.layers} />
              仅渲染
            </Btn>
            <Btn
              tone="primary"
              onClick={modelRun}
              disabled={busy || !provider?.configured || runningRunId !== null}
              title={!provider?.configured ? "未配置模型：请先在 .env.local 填写模型信息" : runningRunId ? "当前 Prompt 的上一次运行尚未结束" : "调用真实 AI 模型，会产生费用"}
              data-testid="btn-run"
            >
              <Icon d={ICONS.play} />
              运行模型
            </Btn>
          </div>
        </header>

        {narrow && (
          <div className="flex gap-1 border-b border-ink-700 px-3 py-1.5 text-[12.5px]" data-testid="narrow-tabs">
            {(
              [
                ["editor", "编辑"],
                ["result", "结果"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} onClick={() => setNarrowPane(id)} aria-pressed={narrowPane === id} className={cx("flex-1 rounded-lg py-1.5", narrowPane === id ? "bg-ink-800 font-medium text-ink-100" : "text-ink-400 hover:text-ink-100")}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div ref={container} className="relative flex min-h-0 flex-1">
          {mode === "debug" && (narrow ? narrowPane === "editor" : true) && (
            <>
              <div className="min-w-0" style={{ width: narrow ? "100%" : `${s.editorPct}%` }}>
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
                    onMoreSnapshots={moreSnapshots}
                    projectId={projectId}
                  />
                )}
              </div>
              {!narrow && (
                <div onMouseDown={() => (dragging.current = true)} className="group relative w-px shrink-0 cursor-col-resize bg-ink-700" role="separator" aria-label="拖动调整宽度">
                  <span className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/20" />
                </div>
              )}
            </>
          )}
          {mode !== "compare" && (!narrow || narrowPane === "result") && (
            <div className="flex min-w-0 flex-1 flex-col bg-ink-850">
              {promptsLoaded && !prompts.length ? (
                <p className="m-4 rounded-xl border border-risk/25 bg-risk/[0.08] p-3 text-[12.5px] text-risk" data-testid="project-missing">
                  该项目不存在或没有提示词。请在左侧切换或新建项目。
                </p>
              ) : (
                <>
                  {mode === "check" && prompt && contextBar()}
                  <div className="min-h-0 flex-1">
                    <ResultPane
                      detail={detail}
                      dirty={dirty}
                      canPreview={capability?.status === "CONNECTED_DEMO_FILES"}
                      loading={busy}
                      onCancel={cancelRun}
                      onRetry={retryRun}
                      emptyHint={emptyHint}
                      recentRun={runs[0]}
                      onOpenRun={replay}
                      example={exampleFixture}
                      onOpenExample={openExample}
                      onCompare={() => s.set("workMode", "compare")}
                      onEditPrompt={() => s.set("workMode", "debug")}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          {mode === "compare" && (
            <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-auto bg-ink-850 p-3" data-testid="compare-mode">
              <section className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
                <header className="border-b border-ink-700/70 px-3.5 py-2 text-[12px] font-semibold">勾选两次运行进行对比（{compare.length}/2）</header>
                <div className="max-h-64 overflow-auto">{historyTable}</div>
              </section>
              {compare.length === 2 ? (
                <RunCompare ids={compare as [string, string]} inline onClose={() => setCompare([])} />
              ) : (
                <Empty>在上面勾选两条运行记录，就会在这里显示它们的差异。常用做法：同一输入，改提示词前后各运行一次。</Empty>
              )}
            </div>
          )}
          {inputDrawer && mode === "check" && prompt && (
            <>
              <div className="absolute inset-0 z-30 bg-ink-100/15" onClick={() => setInputDrawer(false)} aria-hidden="true" />
              <aside className="absolute inset-y-0 left-0 z-40 flex w-[480px] max-w-full flex-col border-r border-ink-700 bg-ink-900 shadow-2xl" role="dialog" aria-label="更换输入" data-testid="input-drawer">
                <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
                  <span className="text-[13px] font-semibold">更换输入</span>
                  <button onClick={() => setInputDrawer(false)} className="text-ink-400 hover:text-ink-100" aria-label="关闭输入抽屉">
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <InputTab
                    projectId={projectId}
                    kind={prompt.prompt_kind}
                    fixtures={fixtures}
                    snapshots={snapshots}
                    capability={capability}
                    // 结果检查模式：选了示例就直接显示它的结果
                    onPickFixture={(id) => void openExample(id)}
                    onSnapshotsChanged={loadSnapshots}
                    onMoreSnapshots={moreSnapshots}
                    onPicked={() => setInputDrawer(false)}
                  />
                </div>
              </aside>
            </>
          )}
        </div>

        {/* 底部运行历史 */}
        {s.historyOpen && mode !== "compare" && (
          <div className="h-60 shrink-0 overflow-auto border-t border-ink-700" data-testid="history">
            {historyTable}
          </div>
        )}
      </main>
      {showGuide && <GuideDialog onClose={closeGuide} />}
    </div>
  );
}

function SideLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center px-2 pb-1.5 text-[11.5px] font-medium text-ink-400">
      {children}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

const ICONS = {
  sidebar: "M3 4.5h14v11H3zM8 4.5v11",
  plus: "M10 4.5v11M4.5 10h11",
  play: "M6.5 4.5l9 5.5-9 5.5z",
  layers: "M10 3.5l7 3.5-7 3.5-7-3.5zM3 10.5l7 3.5 7-3.5M3 13.5",
  history: "M3.5 10a6.5 6.5 0 1 0 2-4.7M3.5 4v3.5H7M10 6.5V10l2.5 1.5",
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
