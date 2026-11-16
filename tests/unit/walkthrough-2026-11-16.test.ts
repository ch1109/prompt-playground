// 2026-11-16 流程走查发现的问题：v15 输出对比能逐行对齐；「重新整理」的模型运行按模型运行对比；文件名看不出类型时要提醒
import { describe, expect, it } from "vitest";
import type { Run } from "@/lib/contracts/run";
import { typeFromName } from "@/lib/materials/guess-type";
import { diffSummary, fromModel, strictConditions } from "@/lib/runs/compare";

describe("版本对比：v15 输出", () => {
  it("商品行按 id 对齐，只列出真正变化的字段", () => {
    const a = { v: 15, r: [{ id: 1, md: "A", og: "中国", issues: [] }, { id: 2, md: "B", og: "日本", issues: [] }] };
    const b = { v: 15, r: [{ id: 1, md: "A", og: "美国", issues: [] }, { id: 2, md: "B", og: "日本", issues: [] }, { id: 3, md: "C", issues: [] }] };
    const { rows } = diffSummary(a, b);
    expect(rows.some((r) => r.kind === "UNALIGNED")).toBe(false);
    expect(rows).toContainEqual({ pointer: "/r/[id=1]/og", kind: "CHANGED", a: '"中国"', b: '"美国"' });
    expect(rows.filter((r) => r.pointer.startsWith("/r/[id=3]")).every((r) => r.kind === "ADDED")).toBe(true);
  });

  it("P2 入仓号分组按 wh 对齐", () => {
    const { rows } = diffSummary({ v: 15, h: [{ wh: "001", tot: { q: "1" } }] }, { v: 15, h: [{ wh: "001", tot: { q: "2" } }] });
    expect(rows).toEqual([{ pointer: "/h/[wh=001]/tot/q", kind: "CHANGED", a: '"1"', b: '"2"' }]);
  });
});

describe("版本对比：重新整理的记录", () => {
  const base = { mode: "MODEL_RUN", model_name: "m", model_provider: "p", built_input_hash: "h", model_params: {}, attached_images: null, input_builder_id: "b", input_manifest: { files: [] } } as unknown as Run;
  it("对模型运行的重新整理按模型运行看待；仅渲染不算", () => {
    expect(fromModel({ ...base, mode: "REPLAY" })).toBe(true);
    expect(fromModel({ ...base, mode: "REPLAY", model_name: null })).toBe(false);
    expect(strictConditions(base, { ...base, mode: "REPLAY" }).applicable).toBe(true);
  });
});

describe("上传：材料类型", () => {
  it("文件名里有类型词才算判断出来，否则提醒确认", () => {
    expect(typeFromName("宏杉委托单.xls")).toBe(true);
    expect(typeFromName("INVOICE-001.pdf")).toBe(true);
    expect(typeFromName("1769762094319.pdf")).toBe(false);
  });
});

describe("思考上限", () => {
  it("thinking_budget 是认可的参数，必须是正整数；不填不限制", async () => {
    const { runBlockers } = await import("@/lib/runs/service");
    const caps = { images: null, nativePdf: false as const, jsonMode: null, thinking: null, streaming: true, maxOutputTokens: null };
    const base = { system: "S", userTemplate: "{{input_json}}" };
    expect(runBlockers({ ...base, params: { thinking_budget: 16000 } }, caps)).toEqual([]);
    expect(runBlockers({ ...base, params: {} }, caps)).toEqual([]);
    expect(runBlockers({ ...base, params: { thinking_budget: 0 } }, caps).map((b) => b.code)).toEqual(["MODEL_PARAM_INVALID"]);
  });

  it("填了就原样发给服务商（DashScope 的 thinking_budget）", async () => {
    const { OpenAICompatibleProvider } = await import("@/lib/models/openai-compatible");
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "m", apiKey: "sk-test-thinking-0001", timeoutMs: 2000 }, fetchImpl);
    await p.complete({ system: "S", user: "U", params: { temperature: 0, thinking_budget: 16000 } });
    expect(sent).toMatchObject({ temperature: 0, thinking_budget: 16000 });
  });
});
