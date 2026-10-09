"use client";
import { create } from "zustand";
import type { SelectionState } from "@/lib/contracts/renderer-config";
import type { RunDetail } from "@/lib/client/types";

export type ResultTab = "visual" | "json" | "schema" | "meta";
export type InputMode = "fixture" | "paste" | "snapshot" | "jiuli";

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
  snapshotId: string | null;
  params: { temperature: number; max_tokens: number };
  runId: string | null;
  /** 产生当前 Run 时的输入签名；与当前编辑签名不同 → DIRTY */
  runInputSig: string | null;
}

export const emptyWorkspace = (): Workspace => ({
  system: "",
  userTemplate: "{{input_json}}",
  versionId: null,
  versionHash: null,
  inputMode: "fixture",
  pasteRaw: "",
  pasteRequest: "",
  fixtureId: null,
  snapshotId: null,
  params: { temperature: 0, max_tokens: 16000 },
  runId: null,
  runInputSig: null,
});

/** 任何影响结果的编辑（提示词、参数、输入）都会改变签名；与产生当前 Run 时的签名不同即 DIRTY */
export function inputSignature(w: Workspace, mode: "RENDER_ONLY" | "MODEL_RUN"): string {
  const input =
    mode === "RENDER_ONLY"
      ? { inputMode: w.inputMode, raw: w.inputMode === "paste" ? w.pasteRaw : null, req: w.inputMode === "paste" ? w.pasteRequest : null, fixture: w.inputMode === "fixture" ? w.fixtureId : null }
      : { snapshot: w.snapshotId };
  return JSON.stringify({ mode, input, system: w.system, user: w.userTemplate, params: w.params });
}

interface StudioState {
  activePromptId: string;
  workspaces: Record<string, Workspace>;
  runs: Record<string, RunDetail>;
  selection: SelectionState;
  resultTab: ResultTab;
  editorPct: number;
  maximized: boolean;
  sidebarCollapsed: boolean;
  historyOpen: boolean;
  evidenceOpen: boolean;
  /** 最后一次运行使用的模式，用于计算 DIRTY */
  lastMode: Record<string, "RENDER_ONLY" | "MODEL_RUN">;
  setActivePrompt(id: string): void;
  patchWorkspace(promptId: string, patch: Partial<Workspace>): void;
  putRun(detail: RunDetail): void;
  select(sel: Omit<SelectionState, "runId">): void;
  clearSelection(): void;
  set<K extends keyof StudioState>(k: K, v: StudioState[K]): void;
}

export const useStudio = create<StudioState>((set, get) => ({
  activePromptId: "jiuli-p1",
  workspaces: {},
  runs: {},
  selection: { runId: null },
  resultTab: "visual",
  editorPct: 42,
  maximized: false,
  sidebarCollapsed: false,
  historyOpen: false,
  evidenceOpen: false,
  lastMode: {},
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
}));

export function useWorkspace(): [Workspace, (patch: Partial<Workspace>) => void, string] {
  const id = useStudio((s) => s.activePromptId);
  const ws = useStudio((s) => s.workspaces[id]) ?? emptyWorkspace();
  const patch = useStudio((s) => s.patchWorkspace);
  return [ws, (p) => patch(id, p), id];
}
