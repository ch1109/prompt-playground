"use client";
import type { InputManifest } from "@/lib/contracts/run";
import { Badge, cx } from "@/components/ui";

const VISUAL_LABEL: Record<InputManifest["visual_evidence"], string> = {
  SENT: "已发送原件图片",
  PARTIAL: "原件图片只发送了一部分",
  NOT_SENT: "未发送原件图片",
  NOT_APPLICABLE: "不涉及图片（没有 PDF / 图片原件）",
};

const pages = (ps: (number | null)[]) => (ps.length ? ps.map((p) => (p === null ? "整图" : p)).join(",") : "无");

/** 输入覆盖清单（R-02）：哪些文件、页、Sheet、文本和图片实际发出；不完整时醒目提示 */
export function InputCoverage({ manifest, planned }: { manifest: InputManifest; planned?: boolean }) {
  const m = manifest;
  return (
    <div className={cx("rounded-lg border p-2 text-[12px]", m.complete ? "border-ink-700" : "border-stamp/50 bg-stamp/5")} data-testid="input-coverage">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink-100">输入覆盖{planned ? "（运行前规划，运行时以实际为准）" : ""}</span>
        <span data-testid="coverage-status">
          <Badge tone={m.complete ? "ok" : "bad"}>{m.complete ? "完整输入" : "不是完整输入"}</Badge>
        </span>
        <Badge tone={m.visual_evidence === "SENT" ? "ok" : m.visual_evidence === "NOT_APPLICABLE" ? "mute" : "warn"}>{VISUAL_LABEL[m.visual_evidence]}</Badge>
        <span className="text-ink-400">
          文本 {m.sent_text_chars.toLocaleString()} 字 · 图片 {m.sent_image_count} 张{m.page_coverage ? ` · 页图覆盖 ${m.page_coverage}` : ""}
        </span>
      </div>
      {m.gaps.map((g) => (
        <p key={g} className="text-stamp">
          ✕ {g}
        </p>
      ))}
      {m.notes.map((n) => (
        <p key={n} className="text-risk">
          ⚠ {n}
        </p>
      ))}
      {m.files.length > 0 ? (
        <table className="mt-1 w-full text-[11.5px]">
          <thead className="text-left text-ink-400">
            <tr>
              <th className="py-0.5 pr-2 font-medium">文件</th>
              <th className="py-0.5 pr-2 font-medium">类型</th>
              <th className="py-0.5 pr-2 font-medium">文本</th>
              <th className="py-0.5 pr-2 font-medium">页 / Sheet</th>
              <th className="py-0.5 pr-2 font-medium">页图</th>
              <th className="py-0.5 font-medium">原件 Hash / 预处理</th>
            </tr>
          </thead>
          <tbody>
            {m.files.map((f) => (
              <tr key={f.file_id} className="border-t border-ink-800 align-top">
                <td className="py-0.5 pr-2">
                  <div className="font-mono">{f.file_id}</div>
                  <div className="text-ink-400">{f.file_name ?? "—"}</div>
                </td>
                <td className="py-0.5 pr-2">{[f.media_type ?? "未知", ...f.roles].join(" · ")}</td>
                <td className={cx("py-0.5 pr-2", !f.text_sent && "text-risk")}>{f.text_sent ? `${f.text_chars.toLocaleString()} 字` : "未发送"}</td>
                <td className="py-0.5 pr-2">
                  {f.sheets?.length
                    ? f.sheets.map((s) => `Sheet「${s.name}」${s.rows ?? "?"} 行${s.columns ? ` × ${s.columns} 列` : ""}`).join("；")
                    : f.text_pages.length
                      ? `文本页 ${f.text_pages.join(",")}${f.total_pages ? ` / 共 ${f.total_pages} 页` : ""}`
                      : f.total_pages
                        ? `共 ${f.total_pages} 页`
                        : "—"}
                </td>
                <td className="py-0.5 pr-2">
                  {f.image_pages_sent === null ? (
                    <span className="text-ink-400">未开启</span>
                  ) : (
                    <>
                      {pages(f.image_pages_sent)}
                      {f.total_pages ? ` / 共 ${f.total_pages}` : ""}
                      {f.image_skipped_reason && <div className="text-risk">{f.image_skipped_reason}</div>}
                    </>
                  )}
                </td>
                <td className="py-0.5 font-mono text-[10.5px] break-all text-ink-400">
                  {f.original_file_hash ? f.original_file_hash.slice(0, 12) + "…" : "未知"}
                  <div className="font-sans">{f.preprocessor_version ?? "未知"}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-ink-400">请求不含原件材料（上游 JSON 输入，来自快照 {m.snapshot_id}，{m.snapshot_source_type}）。</p>
      )}
      <p className="mt-1 text-[10.5px] text-ink-400">
        {m.input_builder} · 快照 {m.snapshot_id}（hash {m.snapshot_hash.slice(0, 10)}…）· {m.version}
      </p>
    </div>
  );
}
