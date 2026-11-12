// 输出版式存储：只追加、版本递增、内容相同不新增、非法被拒、触发器、路由层
import { beforeAll, describe, expect, it } from "vitest";
import { GET, PUT } from "@/app/api/prompts/[id]/layout/route";
import type { Layout } from "@/lib/layouts/types";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { getLayout, listLayouts, saveLayout, saveLayoutForPrompt } from "@/lib/repositories/layouts";
import { ensureSeed } from "@/lib/repositories/prompts";

const A: Layout = { version: 1, kind: "table", itemsPath: "/items", columns: [{ label: "名称", path: "/name" }] };
const B: Layout = { version: 1, kind: "report", sections: [{ title: "结论", path: "/summary" }] };
const LOCAL = "http://127.0.0.1:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const put = (id: string, b: unknown, headers: Record<string, string> = { origin: LOCAL, host: "127.0.0.1:3000" }) =>
  PUT(new Request(`${LOCAL}/api/prompts/${id}/layout`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) }) as never, ctx(id));

beforeAll(() => {
  resetDbForTests(":memory:");
  ensureSeed();
});

describe("版式存储", () => {
  it("没有版式时返回 null", () => {
    expect(getLayout("generic-json")).toBeNull();
  });
  it("版本递增；内容相同不新增；列表新的在前", () => {
    expect(saveLayout("generic-json", A, "AI").layout_version).toBe(1);
    expect(saveLayout("generic-json", A, "USER").layout_version).toBe(1);
    const s2 = saveLayout("generic-json", B, "USER");
    expect(s2).toMatchObject({ layout_version: 2, source: "USER", layout: B });
    expect(saveLayout("generic-json", A, "USER").layout_version).toBe(3);
    expect(getLayout("generic-json")!.layout_version).toBe(3);
    expect(listLayouts("generic-json").map((x) => x.layout_version)).toEqual([3, 2, 1]);
  });
  it("非法版式被拒，且不写入", () => {
    const n = () => listLayouts("generic-json").length;
    const before = n();
    expect(() => saveLayout("generic-json", { version: 1, kind: "table", itemsPath: "items", columns: [] } as unknown as Layout, "USER")).toThrow(/版式不合法/);
    expect(() => saveLayout("generic-json", { ...A, title: "function (){}" }, "USER")).toThrow();
    expect(n()).toBe(before);
  });
  it("UPDATE / DELETE 被触发器拒绝", () => {
    expect(() => db().prepare("UPDATE prompt_layouts SET source = 'AI'").run()).toThrow(/只新增不修改/);
    expect(() => db().prepare("DELETE FROM prompt_layouts").run()).toThrow(/只新增不删除/);
  });
  it("读出时发现库里内容不合法则当作没有", () => {
    db().prepare("INSERT INTO prompt_layouts VALUES ('bad-prompt',1,'{\"x\":1}','AI','t')").run();
    expect(getLayout("bad-prompt")).toBeNull();
  });
});

describe("版式接口", () => {
  it("不存在的提示词：404；非通用提示词：400", async () => {
    expect(() => saveLayoutForPrompt("nope", A)).toThrow(/不存在/);
    expect((await put("nope", { layout: A })).status).toBe(404);
    const r = await put("jiuli-p1", { layout: A });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe("只有通用提示词可以设置版式");
  });
  it("非法版式 400；外来来源 403；合法保存后 GET 能读到", async () => {
    const bad = await put("generic-json", { layout: { kind: "table" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain("版式不合法");
    expect((await put("generic-json", { layout: A }, { origin: "http://evil.com", host: "127.0.0.1:3000" })).status).toBe(403);
    const okRes = await put("generic-json", { layout: B });
    expect(okRes.status).toBe(200);
    const g = await (await GET(new Request(`${LOCAL}/x`) as never, ctx("generic-json"))).json();
    expect(g.data.layout.layout).toEqual(B);
    expect((await GET(new Request(`${LOCAL}/x`) as never, ctx("nope"))).status).toBe(404);
  });
});
