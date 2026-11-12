"use client";
import type { Run } from "@/lib/contracts/run";
import type { RunEvidence } from "@/lib/runs/run-evidence";
import { Badge, cx } from "@/components/ui";

const QUALITY: Record<RunEvidence["capture"]["quality"], { label: string; tone: "ok" | "warn" | "mute" }> = {
  COMPLETE: { label: "证据采集完整", tone: "ok" },
  PARTIAL: { label: "证据采集不完整", tone: "warn" },
  NOT_APPLICABLE: { label: "未调用模型，不适用", tone: "mute" },
};

/** 思考内容：只看请求里有没有设置、响应里有没有，内容本身不保存 */
function thinkingText(run: Run): string {
  const meta = run.response_meta;
  if (!meta) return "未记录";
  const chars = meta.reasoning_content_chars;
  const asked = run.request_actual && Object.keys(run.request_actual).some((k) => /think|reason/i.test(k)) ? "请求中设置了思考参数" : "请求未设置思考参数（服务商默认）";
  return `${asked}；${typeof chars === "number" ? `响应带有思考内容 ${chars.toLocaleString()} 字（未保存）` : "响应中没有思考内容"}`;
}

/** 运行证据（v1.3 §5）：这条运行真实保存了哪些证据、缺了什么、处在哪种诊断状态 */
export function RunEvidencePanel({ run, evidence }: { run: Run; evidence: RunEvidence }) {
  const q = QUALITY[evidence.capture.quality];
  return (
    <div className={cx("rounded-lg border p-2 text-[12px]", evidence.capture.quality === "PARTIAL" ? "border-risk/40 bg-risk/5" : "border-ink-700")} data-testid="run-evidence">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink-100">运行证据</span>
        <span data-testid="capture-quality">
          <Badge tone={q.tone}>{q.label}</Badge>
        </span>
        {evidence.states.map((s) => (
          <span key={s.code + s.label} title={s.reason} data-state={s.code}>
            <Badge tone={s.code === "MODEL_RUN_SUCCESS" ? "ok" : s.code === "EVAL_NOT_AVAILABLE" ? "mute" : "warn"}>{s.label}</Badge>
          </span>
        ))}
      </div>
      {evidence.states
        .filter((s) => s.code !== "MODEL_RUN_SUCCESS")
        .map((s) => (
          <p key={s.code + s.label} className="text-ink-300">
            · {s.label}：{s.reason}
          </p>
        ))}
      {evidence.capture.not_captured.length > 0 && (
        <div className="mt-1" data-testid="not-captured">
          <p className="text-risk">这条运行当时没有保存以下证据（不会事后补造）：</p>
          <ul className="ml-3">
            {evidence.capture.not_captured.map((n) => (
              <li key={n.key} className="text-ink-300">
                ✕ {n.label} <span className="text-ink-400">— {n.limitation}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.mode === "MODEL_RUN" && (
        <dl className="mt-1 grid grid-cols-[140px_1fr] gap-x-2 text-[11.5px]">
          <dt className="text-ink-400">服务商回报的模型</dt>
          <dd className="font-mono">{typeof run.response_meta?.model === "string" ? run.response_meta.model : "未记录"}</dd>
          <dt className="text-ink-400">思考模式</dt>
          <dd>{thinkingText(run)}</dd>
        </dl>
      )}
      {evidence.capture.notes.map((n) => (
        <p key={n} className="text-[11px] text-ink-400">
          ※ {n}
        </p>
      ))}
    </div>
  );
}
