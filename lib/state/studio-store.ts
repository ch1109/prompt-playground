"use client";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SelectionState } from "@/lib/contracts/renderer-config";
import type { RunDetail } from "@/lib/client/types";

export type ResultTab = "visual" | "json" | "details";
/** 工作模式：结果检查（默认，结果占满）/ 提示词调试（编辑区 + 结果区）/ 版本对比 */
export type WorkMode = "check" | "debug" | "compare";
export type InputMode = "fixture" | "paste" | "snapshot" | "jiuli" | "upload";

/** 每个 Prompt 独立的工作草稿与上次 Run（PRD §5.2） */
export interface Workspace {
  system: string;
  userTemplate: string;
  versionId: string | null;
  versionHash: string | null;
  inputMode: InputMode;
  pasteRaw: string;
  pasteRequest: string;
  fixtureId: string | null;
  /** 当前样本对应的快照（样本带请求上下文时，选中即创建/复用）；无上下文为 null */
  fixtureSnapshotId: string | null;
  /** 「已有快照」/九立导入选中的快照 */
  snapshotId: string | null;
  /** 「上传文件」创建的快照 */
  uploadSnapshotId: string | null;
  params: { temperature: number; max_tokens: number };
  /** 是否随请求附带原件页面图片；null = 跟随模型能力（支持看图且输入有 PDF / 图片时自动附带） */
  attachImages: boolean | null;
  runId: string | null;
  /** 产生当前 Run 时的输入签名；与当前编辑签名不同 → DIRTY */
  runInputSig: string | null;
}

export const emptyWorkspace = (): Workspace => ({
  system: "",
  userTemplate: "{{input_json}}",
  versionId: null,
  versionHash: null,
  inputMode: "upload",
  pasteRaw: "",
  pasteRequest: "",
  fixtureId: null,
  fixtureSnapshotId: null,
  snapshotId: null,
  uploadSnapshotId: null,
  // 2026-10-09 批量实测：16000 时 22 次中 4 次截断（含推理输出），默认提高到 32000
  params: { temperature: 0, max_tokens: 32000 },
  attachImages: null,
  runId: null,
  runInputSig: null,
});

/**
 * 真实运行将使用的快照：请求预览、运行、DIRTY 判断都只认这里，保证"预览的就是要发送的"。
 * 只取当前输入模式自己的快照，不沿用其他模式留下的选择；粘贴模式仅用于仅渲染。
 */
export function runSnapshotId(w: Workspace): string | null {
  if (w.inputMode === "fixture") return w.fixtureSnapshotId;
  if (w.inputMode === "snapshot") return w.snapshotId;
  if (w.inputMode === "upload") return w.uploadSnapshotId;
  return null;
}

/** 任何影响结果的编辑（提示词、参数、输入）都会改变签名；与产生当前 Run 时的签名不同即 DIRTY */
export function inputSignature(w: Workspace, mode: "RENDER_ONLY" | "MODEL_RUN"): string {
  const input =
    mode === "RENDER_ONLY"
      ? { inputMode: w.inputMode, raw: w.inputMode === "paste" ? w.pasteRaw : null, req: w.inputMode === "paste" ? w.pasteRequest : null, fixture: w.inputMode === "fixture" ? w.fixtureId : null }
      : { snapshot: runSnapshotId(w) };
  return JSON.stringify({ mode, input, system: w.system, user: w.userTemplate, params: w.params, attachImages: mode === "MODEL_RUN" ? w.attachImages : null });
}

interface StudioState {
  activePromptId: string;
  workspaces: Record<string, Workspace>;
  runs: Record<string, RunDetail>;
  selection: SelectionState;
  resultTab: ResultTab;
  editorPct: number;
  sidebarCollapsed: boolean;
  historyOpen: boolean;
  evidenceOpen: boolean;
  /** 最后一次运行使用的模式，用于计算 DIRTY */
  lastMode: Record<string, "RENDER_ONLY" | "MODEL_RUN">;
  workMode: WorkMode;
  setActivePrompt(id: string): void;
  patchWorkspace(promptId: string, patch: Partial<Workspace>): void;
  putRun(detail: RunDetail): void;
  select(sel: Omit<SelectionState, "runId">): void;
  clearSelection(): void;
  set<K extends keyof StudioState>(k: K, v: StudioState[K]): void;
}

/**
 * 工作区存到浏览器 localStorage，刷新不丢（草稿、输入选择、当前 Run 的 ID、布局）。
 * Run 详情不存，按 ID 从服务端重新读取。skipHydration：挂载后再恢复，避免与服务端首屏不一致。
 */
export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
      activePromptId: "generic-json",
      workspaces: {},
      runs: {},
      selection: { runId: null },
      resultTab: "visual",
      editorPct: 42,
      sidebarCollapsed: false,
      historyOpen: false,
      evidenceOpen: false,
      lastMode: {},
      workMode: "check",
      setActivePrompt: (id) => set({ activePromptId: id, selection: { runId: get().workspaces[id]?.runId ?? null } }),
      patchWorkspace: (promptId, patch) =>
        set((s) => ({ workspaces: { ...s.workspaces, [promptId]: { ...(s.workspaces[promptId] ?? emptyWorkspace()), ...patch } } })),
      putRun: (detail) => set((s) => ({ runs: { ...s.runs, [detail.run.run_id]: detail } })),
      // 选择状态归属于某次 Run；切换标签页时保持
      select: (sel) => {
        const ws = get().workspaces[get().activePromptId];
        set({ selection: { runId: ws?.runId ?? null, ...sel } });
      },
      clearSelection: () => set((s) => ({ selection: { runId: s.selection.runId } })),
      set: (k, v) => set({ [k]: v } as Partial<StudioState>),
    }),
    {
      name: "prompt-studio:workspace",
      version: 2,
      // v2：附带图片改为默认跟随模型能力，旧数据里的默认 false 重置为 null
      migrate: (p, v) => {
        const s = (p ?? {}) as Partial<StudioState>;
        if (v < 2 && s.workspaces) for (const w of Object.values(s.workspaces)) w.attachImages = null;
        return s as StudioState;
      },
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ activePromptId: s.activePromptId, workspaces: s.workspaces, lastMode: s.lastMode, editorPct: s.editorPct, sidebarCollapsed: s.sidebarCollapsed, workMode: s.workMode }),
      // 旧数据缺少新增字段时用默认值补齐
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<StudioState>;
        const workspaces = Object.fromEntries(Object.entries(p.workspaces ?? {}).map(([id, w]) => [id, { ...emptyWorkspace(), ...w }]));
        const activePromptId = p.activePromptId ?? current.activePromptId;
        return { ...current, ...p, workspaces, selection: { runId: workspaces[activePromptId]?.runId ?? null } };
      },
    },
  ),
);

/** 当前 Run 中已有标注的 JSON 指针（表格据此显示标注角标） */
export function useAnnotatedPointers(): Set<string> {
  const anns = useStudio((s) => (s.selection.runId ? s.runs[s.selection.runId]?.annotations : undefined));
  return useMemo(() => new Set((anns ?? []).map((a) => a.target_json_pointer).filter((p): p is string => !!p)), [anns]);
}

export function useWorkspace(): [Workspace, (patch: Partial<Workspace>) => void, string] {
  const id = useStudio((s) => s.activePromptId);
  const ws = useStudio((s) => s.workspaces[id]) ?? emptyWorkspace();
  const patch = useStudio((s) => s.patchWorkspace);
  return [ws, (p) => patch(id, p), id];
}
