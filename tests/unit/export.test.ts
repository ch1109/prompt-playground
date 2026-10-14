// 一键导出运行上下文：保存模型思考全文；ZIP 里的 Markdown（输入、提示词、思考、输出、标注、检查）与原件
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Run } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { resetDbForTests } from "@/lib/repositories/db";
import { getRun } from "@/lib/repositories/runs";
import { modelRun } from "@/lib/runs/service";

const THINKING = "先看委托表第 7 行，产地一栏写的是韩国……";

/** 模拟服务商：返回指定输出，可附带思考内容 */
const provider = (raw: string, reasoning?: string) =>
  new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-export-abc", timeoutMs: 5000 }, (async () =>
    Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: raw, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch);

const runP1 = (reasoning?: string): Promise<Run> => {
  setProviderForTests(provider(getFixture("v3/SC-08/P1")!.raw, reasoning));
  return modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id, system: "系统提示词", userTemplate: "{{input_json}}", params: { temperature: 0 } });
};

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-export-mat-"));
});
afterEach(() => setProviderForTests(undefined));

describe("保存模型思考", () => {
  it("服务商返回思考内容时，新 Run 保存全文；没返回时为 null", async () => {
    const withThinking = await runP1(THINKING);
    expect(getRun(withThinking.run_id)!.reasoning_content).toBe(THINKING);
    expect(getRun(withThinking.run_id)!.response_meta).toMatchObject({ reasoning_content_chars: THINKING.length });
    const without = await runP1();
    expect(getRun(without.run_id)!.reasoning_content).toBeNull();
  });
});
