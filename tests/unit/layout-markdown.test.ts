// 版式显示结果 → Markdown（导出上下文用）
import { describe, expect, it } from "vitest";
import { applyLayout } from "@/lib/layouts/apply";
import { layoutResultToMarkdown } from "@/lib/layouts/to-markdown";
import type { Layout } from "@/lib/layouts/types";

const doc = {
  items: [
    { name: "苹果|红", note: "第一行\n第二行", tags: ["a", "b"], ok: "通过", sev: "高", why: "不合格" },
    { name: "香蕉", note: "x", tags: [], ok: "不通过", sev: "低", why: "缺证" },
  ],
  summary: "整体不错",
};
const md = (l: Layout, d: unknown = doc) => layoutResultToMarkdown(applyLayout(l, d));

describe("layoutResultToMarkdown", () => {
  it("table：表头、分隔行；竖线转义、换行替换、对象转 JSON", () => {
    const t = md({ version: 1, kind: "table", itemsPath: "/items", columns: [{ label: "名称", path: "/name" }, { label: "备注", path: "/note" }, { label: "标签", path: "/tags" }] });
    const lines = t.split("\n");
    expect(lines[0]).toBe("| 名称 | 备注 | 标签 |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    expect(lines[2]).toBe('| 苹果\\|红 | 第一行 第二行 | a、b |');
    expect(lines).toHaveLength(4);
  });
  it("cards：每条一个小标题 + 字段列表", () => {
    const t = md({ version: 1, kind: "cards", itemsPath: "/items", titlePath: "/name", fields: [{ label: "备注", path: "/note" }] });
    expect(t).toContain("#### 苹果|红");
    expect(t).toContain("- 备注：第一行 第二行");
    expect(t).toContain("#### 香蕉");
  });
  it("checklist：通过打勾，未通过带严重度和说明", () => {
    const t = md({ version: 1, kind: "checklist", itemsPath: "/items", titlePath: "/name", statusPath: "/ok", passValues: ["通过"], severityPath: "/sev", detailPath: "/why" });
    const lines = t.split("\n");
    expect(lines[0]).toBe("- [x] 苹果|红：不合格");
    expect(lines[1]).toBe("- [ ] 香蕉（WARNING）：缺证");
  });
  it("report：直接用报告的 Markdown", () => {
    const l: Layout = { version: 1, kind: "report", sections: [{ title: "结论", path: "/summary" }] };
    const r = applyLayout(l, doc);
    expect(r.kind === "report" && layoutResultToMarkdown(r)).toBe(r.kind === "report" ? r.markdown : "");
    expect(md(l)).toContain("整体不错");
  });
  it("mismatch：一行原因", () => {
    const t = md({ version: 1, kind: "table", itemsPath: "/nope", columns: [{ label: "名称", path: "/name" }] });
    expect(t).toMatch(/^版式没对上这次的输出：.+/);
    expect(t).not.toContain("\n");
  });
});
