// 版式解释器：版式 + 原始 JSON → 显示数据。纯函数，不碰网络/数据库/DOM。
import type { IssueView, TableView } from "@/lib/contracts/view-model";
import { getByPointer, join } from "@/lib/pipeline/json-pointer";
import type { Layout, LayoutCard, LayoutResult, LayoutSection } from "./types";

const MAX_ITEMS = 2000;
const DEFAULT_PASS_VALUES = ["通过", "pass", "PASS", "OK", "ok", "true", "是"];

/** 转成业务人员能读的文字：文字列表用「、」连接；对象写成「键：值；键：值」；对象列表每个对象一行（深度有限，超出才退回 JSON） */
function plain(value: unknown, depth = 0): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  if (depth >= 3) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((x) => plain(x, depth + 1));
    return value.every((x) => x === null || typeof x !== "object") ? parts.filter(Boolean).join("、") : parts.join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, x]) => `${k}：${plain(x, depth + 1)}`)
    .join("；");
}

/** 转成纯文本：缺失或 null 为空串，对象/数组见 plain */
function str(found: boolean, value: unknown): string {
  if (!found) return "";
  return plain(value);
}

/** 取某一项上的相对路径值 */
function pick(item: unknown, rel: string): { found: boolean; value?: unknown } {
  return getByPointer(item, rel);
}

/** 取数组项；失败时返回中文原因 */
function getItems(doc: unknown, itemsPath: string): { items: unknown[] } | { reason: string } {
  const r = getByPointer(doc, itemsPath);
  const shown = itemsPath === "" ? "根" : itemsPath;
  if (!r.found) return { reason: `版式没对上：在数据里找不到路径「${shown}」` };
  if (!Array.isArray(r.value)) return { reason: `版式没对上：路径「${shown}」指向的不是列表` };
  return { items: r.value.slice(0, MAX_ITEMS) };
}

function hasAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w.toLowerCase()));
}

export function applyLayout(layout: Layout, doc: unknown): LayoutResult {
  if (layout.kind === "report") {
    const sections: LayoutSection[] = layout.sections.map((s) => {
      const r = getByPointer(doc, s.path);
      if (!r.found) return { title: s.title, text: "", pointer: s.path, found: false };
      const v = r.value;
      let text: string;
      if (Array.isArray(v)) {
        text = v.map((x) => "- " + plain(x).replace(/\n/g, "；")).join("\n");
      } else if (v !== null && typeof v === "object") {
        text = Object.entries(v as Record<string, unknown>)
          .map(([k, x]) => `${k}：${plain(x).replace(/\n/g, "；")}`)
          .join("\n");
      } else {
        text = str(true, v);
      }
      return { title: s.title, text, pointer: s.path, found: true };
    });
    if (!sections.some((s) => s.found)) {
      return { kind: "mismatch", reason: "版式没对上：报告的各章节路径在数据里都找不到" };
    }
    const markdown = sections
      .filter((s) => s.found)
      .map((s) => `## ${s.title}\n\n${s.text}`)
      .join("\n\n");
    return { kind: "report", sections, markdown };
  }

  const got = getItems(doc, layout.itemsPath);
  if ("reason" in got) return { kind: "mismatch", reason: got.reason };
  const { items } = got;

  if (layout.kind === "table") {
    const columns = layout.columns.map((c, i) => ({ key: `c${i}`, title: c.label, kind: c.kind }));
    const table: TableView = {
      id: "layout",
      title: layout.title ?? "结果",
      columns,
      rows: items.map((item, i) => {
        const rowId = `r${i}`;
        const cells: TableView["rows"][number]["cells"] = {};
        layout.columns.forEach((c, ci) => {
          const key = `c${ci}`;
          const r = pick(item, c.path);
          cells[key] = {
            rowId,
            fieldKey: key,
            value: !r.found || r.value === undefined ? "" : r.value !== null && typeof r.value === "object" ? plain(r.value) : r.value,
            jsonPointer: join(layout.itemsPath, i) + c.path,
            sourceRefIds: [],
          };
        });
        return { id: rowId, cells };
      }),
    };
    return { kind: "table", table };
  }

  if (layout.kind === "cards") {
    const cards: LayoutCard[] = items.map((item, i) => {
      const base = join(layout.itemsPath, i);
      const t = pick(item, layout.titlePath);
      const title = str(t.found, t.value) || "（无标题）";
      const card: LayoutCard = {
        id: `r${i}`,
        title,
        fields: layout.fields.map((f) => {
          const r = pick(item, f.path);
          return { label: f.label, value: str(r.found, r.value), pointer: base + f.path };
        }),
        pointer: base,
      };
      if (layout.badgePath !== undefined) {
        const b = pick(item, layout.badgePath);
        const badge = str(b.found, b.value);
        if (badge) card.badge = badge;
      }
      return card;
    });
    return { kind: "cards", cards };
  }

  // checklist
  const passValues = layout.passValues ?? DEFAULT_PASS_VALUES;
  let passCount = 0;
  let failCount = 0;
  const issues: IssueView[] = items.map((item, i) => {
    const base = join(layout.itemsPath, i);
    const t = pick(item, layout.titlePath);
    const summary = str(t.found, t.value) || "（无标题）";
    let passed = false;
    if (layout.statusPath !== undefined) {
      const s = pick(item, layout.statusPath);
      passed = passValues.includes(str(s.found, s.value));
    }
    const issue: IssueView = {
      id: `r${i}`,
      type: passed ? "通过" : "未通过",
      severity: "INFO",
      summary,
      target: { jsonPointer: base },
      sourceRefIds: [],
      origin: "MODEL_FINDING",
    };
    if (layout.detailPath !== undefined) {
      const d = pick(item, layout.detailPath);
      const detail = str(d.found, d.value);
      if (detail) issue.detail = detail;
    }
    if (passed) {
      passCount++;
    } else {
      failCount++;
      let sev: "BLOCKER" | "WARNING" = "WARNING";
      if (layout.severityPath !== undefined) {
        const v = pick(item, layout.severityPath);
        if (hasAny(str(v.found, v.value), ["严重", "BLOCKER", "high", "高"])) sev = "BLOCKER";
      }
      issue.severity = sev;
    }
    return issue;
  });
  return { kind: "checklist", issues, passCount, failCount };
}
