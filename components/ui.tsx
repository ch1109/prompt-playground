"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { CellState } from "@/lib/contracts/view-model";
import { stateLabel } from "@/lib/adapters/helpers";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Btn({ tone = "ghost", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" | "outline" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-medium transition-[background-color,border-color,color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
        tone === "primary" && "bg-ink-100 text-white shadow-[0_2px_8px_-2px_rgb(0_0_0/0.4)] hover:bg-ink-300",
        tone === "ghost" && "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
        tone === "outline" && "border border-ink-700 bg-ink-900 text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-ink-600 hover:bg-ink-850",
        tone === "danger" && "border border-stamp/40 text-stamp hover:bg-stamp-soft",
        className,
      )}
    />
  );
}

/** 分段页签：灰色轨道 + 选中项白色胶囊 */
export const SEG_TRACK = "flex gap-0.5 rounded-[10px] bg-ink-800 p-[3px]";
export function segItem(active: boolean) {
  return cx(
    "whitespace-nowrap rounded-[7px] px-3 py-1 text-[12.5px] transition-colors",
    active ? "bg-ink-900 font-medium text-ink-100 shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_rgb(0_0_0/0.03)]" : "text-ink-400 hover:text-ink-100",
  );
}

/** 抽屉、弹窗右上角的关闭按钮 */
export function CloseBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} title="关闭" className="grid h-7 w-7 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100">
      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M5 5l10 10M15 5L5 15" />
      </svg>
    </button>
  );
}

const TONES: Record<string, string> = {
  ok: "border-verify/20 bg-verify/[0.08] text-verify",
  warn: "border-risk/25 bg-risk/[0.08] text-risk",
  bad: "border-stamp/25 bg-stamp/[0.07] text-stamp",
  info: "border-info/20 bg-info/[0.07] text-info",
  mute: "border-ink-700 bg-ink-850 text-ink-300",
};

export function Badge({ tone = "mute", children, title, className }: { tone?: keyof typeof TONES; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px font-mono text-[10.5px] leading-4", TONES[tone], className)}>
      {children}
    </span>
  );
}

export const RUN_STATUS_TONE: Record<string, keyof typeof TONES> = {
  SUCCEEDED: "ok",
  SCHEMA_INVALID: "warn",
  PARSE_ERROR: "bad",
  MODEL_ERROR: "bad",
  ADAPTER_ERROR: "bad",
  RUNNING: "info",
  CANCELLED: "mute",
  CREATED: "mute",
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "模型运行成功",
  SCHEMA_INVALID: "结构不符",
  PARSE_ERROR: "JSON 解析失败",
  MODEL_ERROR: "模型调用失败",
  ADAPTER_ERROR: "整理表格出错",
  RUNNING: "运行中",
  CANCELLED: "已取消",
  CREATED: "已创建",
};

/**
 * 运行状态徽章。通用提示词没有预设结构，成功就是「完成」；
 * 九立预设成功但结构没对上时不显示"运行成功"，避免误以为已通过校验；
 * 没调用模型的结果（仅渲染 / 回放）不说「模型运行成功」。
 */
/** fromModel：输出来自真实模型调用（对模型运行「重新整理」的记录也算），这时不说「未调用模型」 */
export function runStatusView(status: string, schemaId: string | null | undefined, kind?: string, mode?: string, fromModel?: boolean): { label: string; tone: keyof typeof TONES } {
  if (status === "SUCCEEDED" && kind === "GENERIC_JSON") return { label: "完成", tone: "ok" };
  if (status === "SUCCEEDED" && !schemaId) return { label: "未校验（不符合预设结构）", tone: "mute" };
  if (status === "SUCCEEDED" && mode && mode !== "MODEL_RUN" && !fromModel) return { label: "已整理（未调用模型）", tone: "ok" };
  return { label: RUN_STATUS_LABEL[status] ?? status, tone: RUN_STATUS_TONE[status] ?? "mute" };
}

/** 业务状态词的颜色语义（不是准确率） */
export function stateTone(raw: string): keyof typeof TONES {
  const v = raw.replace(/（.*$/, "");
  if (/^(MATCHED|COMPLETE|VERIFIED_CONSISTENT|SUCCESS|KEEP|DISJOINT)$/.test(v)) return "ok";
  if (/^(VERIFIED_UPDATED|FILL|UPDATE)$/.test(v)) return "info";
  if (/^(CONFLICT|MISSING|MISSING_REQUIRED|UNMATCHED|INVALID_INPUT|OVERLAPPING)$/.test(v)) return "bad";
  if (/^(MULTIPLE_CANDIDATES|PARTIAL|UNCERTAIN|NO_EVIDENCE|NEEDS_REVIEW|UNKNOWN)$/.test(v)) return "warn";
  return "mute";
}

/** 单元格取值显示：区分 明确无牌 / 空字符串 / null / 0（AT03），所有业务字符串按纯文本渲染 */
export function CellValue({ value, state, kind }: { value: unknown; state?: CellState; kind?: string }) {
  // 模型没写这一项（v15 约定原件没有就不写）；与空字符串「（空）」、null 区分开
  if (value === undefined) return <span className="text-ink-700" title="模型没有输出这一项">—</span>;
  if (value === null) return <span className="font-mono text-ink-600">null</span>;
  if (value === "") return <span className="text-ink-600" title="模型输出空字符串（未识别/缺失）">（空）</span>;
  if (typeof value === "boolean") return <Badge tone={value ? "warn" : "mute"}>{String(value)}</Badge>;
  if (typeof value === "object") return <span className="font-mono text-[11px] text-ink-300">{JSON.stringify(value)}</span>;
  const s = String(value);
  if (kind === "state") {
    const { label, code } = stateLabel(s);
    return <Badge tone={stateTone(s)} title={code || undefined}>{label}</Badge>;
  }
  return (
    <span className={cx(state === "EXPLICIT_NONE" && "text-risk")}>
      {s}
      {state === "EXPLICIT_NONE" && <span className="ml-1 rounded-md bg-risk/10 px-1 text-[10px] text-risk">明确无牌</span>}
    </span>
  );
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-[12.5px] font-semibold tracking-tight text-ink-100">{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-5 text-[12.5px] text-ink-400">{children}</div>;
}
