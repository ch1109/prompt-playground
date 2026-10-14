// 选模型：服务商模型列表只列对话模型；运行时换模型，请求和 Run 记录都写明实际用的模型
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { availableModels, isAvailableModel } from "@/lib/models/catalog";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { resetDbForTests } from "@/lib/repositories/db";
import { modelRun } from "@/lib/runs/service";

beforeAll(() => resetDbForTests(":memory:"));
afterEach(() => setProviderForTests(undefined));

const LISTED = ["qwen3.6-35b-a3b", "deepseek-v4-pro", "qwen-plus", "qwen-plus-2025-07-14", "qwen-max-0107", "text-embedding-v4", "cosyvoice-v2", "MiniMax/speech-02-hd", "qwen-flash-character", "wanx2.1-t2i-plus", "test-sre-gpu-auto-handle"];

function fakeProvider(onCall?: (body: Record<string, unknown>) => void) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://model.invalid/v1", model: "qwen3.6-35b-a3b", apiKey: "sk-test-model-select", timeoutMs: 2000, capabilities: { images: true, nativePdf: false, jsonMode: null, thinking: null, streaming: false, maxOutputTokens: 8000 } },
    (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return Response.json({ object: "list", data: LISTED.map((id) => ({ id, object: "model" })) });
      const body = JSON.parse(String(init?.body));
      onCall?.(body);
      return Response.json({ id: "x", model: body.model, choices: [{ message: { content: getFixture("v3/SC-08/P1")!.raw }, finish_reason: "stop" }], usage: null });
    }) as unknown as typeof fetch,
  );
}

describe("模型列表", () => {
  it("只列对话模型，去掉带日期的快照，默认模型排第一", async () => {
    setProviderForTests(fakeProvider());
    const list = await availableModels();
    expect(list.default).toBe("qwen3.6-35b-a3b");
    expect(list.models).toEqual(["qwen3.6-35b-a3b", "deepseek-v4-pro", "qwen-plus"]);
    expect(list.error).toBeNull();
    expect(await isAvailableModel("deepseek-v4-pro")).toBe(true);
    expect(await isAvailableModel("text-embedding-v4")).toBe(false);
    expect(await isAvailableModel("随便写的模型")).toBe(false);
  });
});

describe("运行时换模型", () => {
  it("请求发给所选模型，Run 记录所选模型；能力声明不沿用默认模型的", async () => {
    let sent: Record<string, unknown> = {};
    setProviderForTests(fakeProvider((b) => (sent = b)));
    const snapshotId = snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id;
    // 默认模型声明了输出上限 8000；换模型后不沿用这条声明，max_tokens 20000 不会被阻断
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId, system: "S", userTemplate: "{{input_json}}", params: { max_tokens: 20000 }, model: "deepseek-v4-pro" });
    expect(sent.model).toBe("deepseek-v4-pro");
    expect(run.model_name).toBe("deepseek-v4-pro");
    expect(run.status).not.toBe("MODEL_ERROR");
  });

  it("不传模型时仍用默认模型", async () => {
    let sent: Record<string, unknown> = {};
    setProviderForTests(fakeProvider((b) => (sent = b)));
    const snapshotId = snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id;
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(sent.model).toBe("qwen3.6-35b-a3b");
    expect(run.model_name).toBe("qwen3.6-35b-a3b");
  });
});
