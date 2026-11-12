import type { LayoutResult } from "./types";

// 把版式显示结果（LayoutResult）转成 Markdown，用于导出上下文。纯函数，不读数据库。

const text = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
/** 表格单元格：换行换成空格，竖线转义 */
const cell = (v: unknown) => text(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export function layoutResultToMarkdown(r: LayoutResult): string {
  switch (r.kind) {
    case "mismatch":
      return `版式没对上这次的输出：${r.reason}`;
    case "report":
      return r.markdown;
    case "table": {
      const { columns, rows } = r.table;
      if (!columns.length) return "（没有列）";
      const lines = [`| ${columns.map((c) => cell(c.title)).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
      for (const row of rows) lines.push(`| ${columns.map((c) => cell(row.cells[c.key]?.value)).join(" | ")} |`);
      return lines.join("\n");
    }
    case "cards":
      if (!r.cards.length) return "（没有条目）";
      return r.cards
        .map((c) => [`#### ${text(c.title).replace(/\s+/g, " ")}${c.badge ? `（${c.badge}）` : ""}`, ...c.fields.map((f) => `- ${f.label}：${f.value.replace(/\r?\n/g, " ")}`)].join("\n"))
        .join("\n\n");
    case "checklist":
      if (!r.issues.length) return "（没有条目）";
      return r.issues
        .map((i) => {
          const pass = i.severity === "INFO";
          const sev = i.severity && i.severity !== "INFO" ? `（${i.severity}）` : "";
          return `- [${pass ? "x" : " "}] ${i.summary.replace(/\r?\n/g, " ")}${sev}${i.detail ? `：${i.detail.replace(/\r?\n/g, " ")}` : ""}`;
        })
        .join("\n");
  }
}
