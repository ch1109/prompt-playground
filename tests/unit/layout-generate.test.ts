// AI 生成版式：重试逻辑、截断、路由层的外发确认与来源校验
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/prompts/[id]/layout/generate/route";
import { generateLayout, truncateSample } from "@/lib/layouts/generate";
import type { ModelRequest, ModelResult, ProviderAdapter } from "@/lib/models/provider-adapter";
import { setProviderForTests } from "@/lib/models/openai-compatible";
import { resetDbForTests } from "@/lib/repositories/db";
import { createPrompt } from "@/lib/repositories/prompts";
import { renderOnly } from "@/lib/runs/service";

const SAMPLE = { items: [{ name: "甲", qty: 1 }, { name: "乙", qty: 2 }] };
const GOOD = JSON.stringify({ version: 1, kind: "table", itemsPath: "/items", columns: [{ label: "名称", path: "/name" }, { label: "数量", path: "/qty", kind: "number" }] });
const WRONG_PATH = JSON.stringify({ version: 1, kind: "table", itemsPath: "/nope", columns: [{ label: "名称", path: "/name" }] });
const LOCAL = "http://127.0.0.1:3000";

let reqs: ModelRequest[] = [];
function fake(replies: (string | { code: string })[], host = "model.invalid", configured = true): ProviderAdapter {
  let i = 0;
  return {
    info: () => ({ provider: "fake", model: "fake-model", configured, supportsFileInput: false, adapterVersion: "t", baseUrlHost: host, capabilities: { images: null, nativePdf: false, jsonMode: null, thinking: null, streaming: false, maxOutputTokens: null } }),
    async complete(req): Promise<ModelResult> {
      reqs.push(req);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (typeof r !== "string") return { ok: false, code: r.code, message: "原文 sk-secret-1234567890", latencyMs: 1 };
      return { ok: true, raw: r, usage: null, latencyMs: 1, responseMeta: {} };
    },
  };
}
const run = (replies: (string | { code: string })[], sample: unknown = SAMPLE) => (setProviderForTests(fake(replies)), generateLayout({ promptText: "提示词", sample }));

let promptId = "";
let runId = "";
const post = (b: unknown, headers: Record<string, string> = { origin: LOCAL, host: "127.0.0.1:3000" }) =>
  POST(new Request(`${LOCAL}/api/prompts/${promptId}/layout/generate`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) }) as never, { params: Promise.resolve({ id: promptId }) } as never);

beforeAll(() => {
  resetDbForTests(":memory:");
  promptId = createPrompt({ projectId: "jiuli", name: "通用", kind: "GENERIC_JSON" }).prompt_id;
  runId = renderOnly({ projectId: "jiuli", promptId, raw: JSON.stringify(SAMPLE) }).run_id;
});
afterEach(() => {
  setProviderForTests(undefined);
  reqs = [];
});

describe("generateLayout", () => {
  it("第一次就合法 -> ok，只调用 1 次", async () => {
    const r = await run([GOOD]);
    expect(r).toMatchObject({ ok: true, layout: { kind: "table" } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].params.temperature).toBe(0);
  });

  it("支持围栏包裹的 JSON", async () => {
    expect((await run(["```json\n" + GOOD + "\n```"])).ok).toBe(true);
  });

  it("第一次非法 JSON，第二次合法 -> ok，调用 2 次且第二轮带上错误", async () => {
    const r = await run(["我觉得应该用表格", GOOD]);
    expect(r.ok).toBe(true);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].user).toContain("不是一个合法的 JSON");
  });

  it("第一次路径对不上，第二次合法 -> ok", async () => {
    const r = await run([WRONG_PATH, GOOD]);
    expect(r.ok).toBe(true);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].user).toContain("/nope");
  });

  it("样例里数组为空时不要求有行", async () => {
    expect((await run([GOOD], { items: [] })).ok).toBe(true);
  });

  it("用户指定形态但模型给了别的 -> 重试", async () => {
    setProviderForTests(fake([GOOD, JSON.stringify({ version: 1, kind: "cards", itemsPath: "/items", titlePath: "/name", fields: [] })]));
    const r = await generateLayout({ promptText: "p", sample: SAMPLE, want: "cards" });
    expect(r).toMatchObject({ ok: true, layout: { kind: "cards" } });
    expect(reqs).toHaveLength(2);
  });

  it("两次都失败 -> ok:false，中文原因", async () => {
    const r = await run(["乱说", WRONG_PATH]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/两次都没能生成/);
    expect(reqs).toHaveLength(2);
  });

  it("模型调用失败 -> ok:false，中文说明，不泄露密钥，不重试", async () => {
    const r = await run([{ code: "MODEL_HTTP_401" }]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.message).toContain("API 密钥无效");
      expect(r.message).not.toContain("sk-secret");
    }
    expect(reqs).toHaveLength(1);
  });
});

describe("truncateSample", () => {
  it("小样例原样返回", () => {
    expect(truncateSample({ a: 1 })).toEqual({ text: '{"a":1}', truncated: false });
  });
  it("大数组被截断，仍保留前几项，总长不超上限", () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i, text: "内容".repeat(30) }));
    const t = truncateSample(big, 6000);
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(6000);
    const arr = JSON.parse(t.text) as { id: number }[];
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr[0].id).toBe(0);
  });
  it("发给模型的提示里说明已截断", async () => {
    await run([GOOD], Array.from({ length: 500 }, (_, i) => ({ name: "x".repeat(50), qty: i })));
    expect(reqs[0].user).toContain("已截断");
  });
});

describe("路由", () => {
  it("非本机来源 -> 403", async () => {
    setProviderForTests(fake([GOOD]));
    expect((await post({ run_id: runId }, { origin: "https://evil.example", host: "127.0.0.1:3000" })).status).toBe(403);
    expect(reqs).toHaveLength(0);
  });

  it("未确认外发 -> 409 EGRESS_NOT_CONFIRMED，模型没被调用", async () => {
    setProviderForTests(fake([GOOD]));
    const res = await post({ run_id: runId });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "EGRESS_NOT_CONFIRMED", details: { provider_host: "model.invalid" } });
    expect(reqs).toHaveLength(0);
  });

  it("run 不属于该提示词 -> 400", async () => {
    setProviderForTests(fake([GOOD]));
    const res = await post({ run_id: "run_nope" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("这次运行没有可用的 JSON 输出");
  });

  it("已确认后成功，只返回版式", async () => {
    const { recordEgressConsent } = await import("@/lib/repositories/egress");
    recordEgressConsent("jiuli", "model.invalid", "测试");
    setProviderForTests(fake([GOOD]));
    const res = await post({ run_id: runId });
    expect(res.status).toBe(200);
    expect((await res.json()).data.layout.kind).toBe("table");
  });
});
