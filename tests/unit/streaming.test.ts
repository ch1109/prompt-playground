// 流式接收模型输出：边生成边显示；超时只在长时间没有新内容时触发；中途断开保留已收到的部分
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { resetDbForTests } from "@/lib/repositories/db";
import { getRun } from "@/lib/repositories/runs";
import { liveRun, startModelRun } from "@/lib/runs/service";

const cfg = (timeoutMs = 2000) => ({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-stream-123456", timeoutMs });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按顺序推送 SSE 事件；gapMs 为每段之间的间隔；hangAfter 推完后不结束也不关闭（模拟卡住） */
function sse(events: unknown[], o: { gapMs?: number; hang?: boolean; close?: boolean } = {}) {
  let sent: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        for (const e of events) {
          if (o.gapMs) await sleep(o.gapMs);
          if (init?.signal?.aborted) return;
          c.enqueue(enc.encode(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`));
        }
        if (!o.hang) c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent: () => sent };
}

const delta = (d: { content?: string; reasoning_content?: string }, finish: string | null = null) => ({ id: "chatcmpl-1", model: "fake-model", created: 1, choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usage = { id: "chatcmpl-1", model: "fake-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 5 } } };

describe("OpenAI 兼容适配器：流式接收", () => {
  it("累计思考与回答、每段回调一次；请求里带 stream 与 usage 选项；结果与一次性返回的格式一致", async () => {
    const { fetchImpl, sent } = sse([delta({ reasoning_content: "先看" }), delta({ reasoning_content: "表头" }), delta({ content: '{"a":' }), delta({ content: "1}" }, "stop"), usage, "[DONE]"]);
    const seen: { content: string; reasoning: string }[] = [];
    const r = await new OpenAICompatibleProvider(cfg(), fetchImpl).complete({ system: "S", user: "U", params: { temperature: 0 }, onProgress: (p) => seen.push(p) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.raw).toBe('{"a":1}');
    expect(r.reasoning).toBe("先看表头");
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(r.responseMeta).toMatchObject({ id: "chatcmpl-1", finish_reason: "stop", reasoning_content_chars: 4, streamed: true, usage: usage.usage });
    expect(sent()).toMatchObject({ stream: true, stream_options: { include_usage: true }, temperature: 0 });
    expect(r.request).toMatchObject({ stream: true });
    expect(seen.at(-1)).toEqual({ content: '{"a":1}', reasoning: "先看表头" });
    expect(seen.some((p) => p.reasoning && !p.content)).toBe(true);
  });

  it("总时长超过超时设置、但一直有新内容 → 不判超时", async () => {
    const parts = Array.from({ length: 8 }, (_, i) => delta({ content: String(i) }, i === 7 ? "stop" : null));
    const { fetchImpl } = sse([...parts, "[DONE]"], { gapMs: 40 });
    const r = await new OpenAICompatibleProvider(cfg(150), fetchImpl).complete({ system: "S", user: "U", params: {}, onProgress: () => {} });
    expect(r).toMatchObject({ ok: true, raw: "01234567" });
  });

  it("输出到一半卡住 → 超时，并保留已收到的回答", async () => {
    const { fetchImpl } = sse([delta({ content: '{"rows":[' })], { hang: true });
    const r = await new OpenAICompatibleProvider(cfg(100), fetchImpl).complete({ system: "S", user: "U", params: {}, onProgress: () => {} });
    expect(r).toMatchObject({ ok: false, code: "MODEL_TIMEOUT", partialRaw: '{"rows":[' });
    if (!r.ok) expect(r.message).toContain("秒没有收到模型的新内容");
  });

  it("没有结束标记就断开 → 断流，保留已收到的回答；途中报错 → 断流并带服务商原文", async () => {
    const cut = await new OpenAICompatibleProvider(cfg(), sse([delta({ content: "半截" })]).fetchImpl).complete({ system: "S", user: "U", params: {}, onProgress: () => {} });
    expect(cut).toMatchObject({ ok: false, code: "MODEL_STREAM_BROKEN", partialRaw: "半截" });
    const err = await new OpenAICompatibleProvider(cfg(), sse([delta({ content: "x" }), { error: { message: "内部错误 sk-test-stream-123456" } }]).fetchImpl).complete({ system: "S", user: "U", params: {}, onProgress: () => {} });
    expect(err).toMatchObject({ ok: false, code: "MODEL_STREAM_BROKEN" });
    if (!err.ok) {
      expect(err.message).toContain("内部错误");
      expect(err.message).not.toContain("sk-test-stream-123456");
    }
  });

  it("服务商不支持流式、直接返回 JSON → 按一次性返回处理", async () => {
    const fetchImpl = (async () => Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    const r = await new OpenAICompatibleProvider(cfg(), fetchImpl).complete({ system: "S", user: "U", params: {}, onProgress: () => {} });
    expect(r).toMatchObject({ ok: true, raw: "{}" });
  });
});

describe("运行服务：实时进度", () => {
  beforeAll(() => resetDbForTests(":memory:"));
  afterEach(() => setProviderForTests(undefined));

  it("运行中能读到阶段与已收到的内容；结束后进度清掉，Run 保存完整回答与思考", async () => {
    const raw = getFixture("v3/SC-08/P1")!.raw;
    const half = Math.floor(raw.length / 2);
    const { fetchImpl } = sse([delta({ reasoning_content: "想一想" }), delta({ content: raw.slice(0, half) }), delta({ content: raw.slice(half) }, "stop"), "[DONE]"], { gapMs: 60 });
    setProviderForTests(new OpenAICompatibleProvider(cfg(), fetchImpl));
    const { runId, done } = startModelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(liveRun(runId)?.phase).toBe("waiting");
    const phases = new Set<string>();
    let sawPartial = false;
    while (liveRun(runId)) {
      const l = liveRun(runId)!;
      phases.add(l.phase);
      if (l.content && l.content.length < raw.length) sawPartial = true;
      await sleep(10);
    }
    const run = await done;
    expect(phases).toContain("thinking");
    expect(phases).toContain("writing");
    expect(sawPartial).toBe(true);
    expect(liveRun(runId)).toBeUndefined();
    expect(run.status).toBe("SUCCEEDED");
    expect(getRun(runId)).toMatchObject({ raw_response: raw, reasoning_content: "想一想", response_meta: { streamed: true } });
  });
});
