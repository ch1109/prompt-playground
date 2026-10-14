// v1.3 §6.3：数据集分层、冻结标注作为标准答案（gold_version）、holdout 对 Agent 隐藏答案、规则集版本
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import type { Run } from "@/lib/contracts/run";
import { createDatasetVersion, goldVersion } from "@/lib/datasets/service";
import { RULESET_VERSION } from "@/lib/experiments/business-rules";
import { createCandidate, evaluateExperiment, planExperiment, startExperiment } from "@/lib/experiments/service";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createGrant, DIAGNOSE_SCOPES, EXPERIMENT_SCOPES, type Scope } from "@/lib/repositories/agent-access";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { getDataset } from "@/lib/repositories/datasets";
import { addAnnotation, updateAnnotation } from "@/lib/repositories/runs";
import { listVersions } from "@/lib/repositories/prompts";
import { modelRun } from "@/lib/runs/service";

const DEV = "v3/SC-08/P1";
const REG = "v3/2026AG001-audit/P1";
const HOLD = "v3/2026CNKJ001-audit/P1";
const FIX = "\n（数据集测试的修改）";
const POINTER = "/output/rows/0/values/origin";

/** 所有样本都返回 SC-08 的录制输出（这里只测评判依据与权限，不测修复效果） */
const provider = () =>
  new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-ds", timeoutMs: 2000 }, (async () =>
    Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: getFixture(DEV)!.raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch);

const base = () => listVersions("jiuli-p1").find((v) => v.label.startsWith("v3.0 原文"))!;
const runOn = (sample: string) =>
  modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapshotForFixture("jiuli", getFixture(sample)!)!.snapshot_id, system: base().system_prompt, userTemplate: base().user_prompt_template, promptVersionId: base().version_id, params: { temperature: 0 } });
const annotate = (run: Run, expected: string, note: string) =>
  addAnnotation({ run_id: run.run_id, target_json_pointer: POINTER, target: null, issue_type: "ASSESSMENT", expected_value: expected, note, assessment: "WRONG", error_category: "UNKNOWN", category_confirmed: null, model_value: null, source_ref_ids: [], author: "我" });

let devRun: Run;
let holdRun: Run;
let devAnnId: string;

beforeAll(async () => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-ds-mat-"));
  setProviderForTests(provider());
  devRun = await runOn(DEV);
  holdRun = await runOn(HOLD);
  await runOn(REG);
  setProviderForTests(undefined);
  devAnnId = annotate(devRun, "答案-v1", "开发样本的备注").annotation_id;
  annotate(holdRun, "保留集的答案", "保留集的备注");
});
afterEach(() => setProviderForTests(undefined));

const samples = [
  { sample_id: DEV, split: "dev" as const },
  { sample_id: REG, split: "regression" as const },
  { sample_id: HOLD, split: "holdout" as const },
];

describe("数据集版本", () => {
  it("新建时冻结每个样本当前的标注；改标注后旧版本不变，新版本才用新答案；版本只新增不修改", () => {
    const v1 = createDatasetVersion({ promptId: "jiuli-p1", name: "P1 基准", samples, createdBy: "我" });
    expect(v1.version).toBe(1);
    expect(v1.samples.find((s) => s.sample_id === DEV)!.gold).toEqual([expect.objectContaining({ annotation_id: devAnnId, expected_value: "答案-v1", revision: 1 })]);
    expect(v1.samples.find((s) => s.sample_id === REG)!.gold).toEqual([]);

    updateAnnotation(devAnnId, { issue_type: "ASSESSMENT", expected_value: "答案-v2", note: "改过" });
    expect(getDataset(v1.dataset_id, 1)!.samples.find((s) => s.sample_id === DEV)!.gold[0].expected_value).toBe("答案-v1");

    const v2 = createDatasetVersion({ promptId: "jiuli-p1", datasetId: v1.dataset_id, samples, createdBy: "我" });
    expect(v2).toMatchObject({ version: 2, name: "P1 基准" });
    expect(v2.samples.find((s) => s.sample_id === DEV)!.gold[0]).toMatchObject({ expected_value: "答案-v2", revision: 2 });
    expect(goldVersion(v2)).toBe(`${v1.dataset_id}@2`);

    expect(() => db().prepare("UPDATE datasets SET name = 'x'").run()).toThrow(/只新增/);
    expect(() => db().prepare("DELETE FROM datasets").run()).toThrow(/只新增/);
  });

  it("分层不合法、样本重复、样本与提示词阶段不符都拒绝", () => {
    expect(() => createDatasetVersion({ promptId: "jiuli-p1", name: "x", samples: [{ sample_id: DEV, split: "train" as never }], createdBy: "我" })).toThrow(/分层只能是/);
    expect(() => createDatasetVersion({ promptId: "jiuli-p1", name: "x", samples: [samples[0], samples[0]], createdBy: "我" })).toThrow(/重复/);
    expect(() => createDatasetVersion({ promptId: "jiuli-p1", name: "x", samples: [{ sample_id: "v3/SC-08/P2", split: "dev" }], createdBy: "我" })).toThrow(/不符/);
  });
});

describe("按数据集试运行", () => {
  const candidate = () => createCandidate({ promptId: "jiuli-p1", baseVersionId: base().version_id, system: base().system_prompt + FIX + Math.random(), userTemplate: base().user_prompt_template, reason: "测试", createdBy: "agent" }).candidate;

  it("regression 层自动加入；不在数据集里的样本、holdout 样本都拒绝（不带数据集也不能用 holdout）", () => {
    setProviderForTests(provider());
    const ds = createDatasetVersion({ promptId: "jiuli-p1", name: "试运行用", samples, createdBy: "我" });
    const c = candidate();
    const plan = planExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: DEV, role: "TARGET" }], maxModelRuns: 10, datasetRef: goldVersion(ds) });
    expect(plan.samples.map((s) => [s.sample_id, s.role])).toEqual([
      [DEV, "TARGET"],
      [REG, "REGRESSION"],
    ]);
    expect(plan.dataset).toEqual({ dataset_id: ds.dataset_id, version: ds.version });
    expect(() => planExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: "v3/2026BMH001-audit/P1", role: "TARGET" }], maxModelRuns: 10, datasetRef: ds.dataset_id })).toThrow(/不在数据集/);
    expect(() => planExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: HOLD, role: "TARGET" }], maxModelRuns: 10, datasetRef: ds.dataset_id })).toThrow(/holdout/);
    expect(() => planExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: HOLD, role: "TARGET" }], maxModelRuns: 10 })).toThrow(/holdout/);
  });

  it("评判用冻结的标准答案：之后再改标注，重新评判结果不变；报告写明 gold_version 与规则集版本", async () => {
    setProviderForTests(provider());
    const ds = createDatasetVersion({ promptId: "jiuli-p1", name: "冻结", samples, createdBy: "我" });
    const frozen = ds.samples.find((s) => s.sample_id === DEV)!.gold[0].expected_value;
    const c = candidate();
    const { done } = startExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: DEV, role: "TARGET" }], maxModelRuns: 10, datasetRef: goldVersion(ds), createdBy: "agent" });
    const exp = await done;
    expect(exp.status).toBe("COMPLETED");
    expect(exp.report).toMatchObject({ gold_version: goldVersion(ds), ruleset_version: RULESET_VERSION });
    expect(exp.report!.limitations[0]).toContain(goldVersion(ds));
    const fieldOf = (r: NonNullable<typeof exp.report>) => r.samples.find((s) => s.sample_id === DEV)!.annotated_fields[0];
    expect(fieldOf(exp.report!).expected_value).toBe(frozen);

    updateAnnotation(devAnnId, { issue_type: "ASSESSMENT", expected_value: "之后改的答案", note: null });
    const again = await evaluateExperiment(exp.experiment_id);
    expect(fieldOf(again.report!).expected_value).toBe(frozen);
  });

  it("不按数据集的试运行：报告写明没有版本化的标准答案", async () => {
    setProviderForTests(provider());
    const { done } = startExperiment({ candidateId: candidate().candidate_id, samples: [{ sample_id: DEV, role: "TARGET" }, { sample_id: REG, role: "REGRESSION" }], maxModelRuns: 10, createdBy: "agent" });
    const exp = await done;
    expect(exp.report).toMatchObject({ gold_version: null, ruleset_version: RULESET_VERSION });
    expect(exp.report!.limitations[0]).toMatch(/没有版本化的标准答案/);
  });
});

describe("Agent 看不到 holdout 答案", () => {
  const tok = (scopes: Scope[]) => createGrant({ principal: "agent-ds", projectIds: ["jiuli"], scopes }).token;
  async function call(t: string, name: string, args: Record<string, unknown>) {
    const res = await POST(
      new Request("http://127.0.0.1:3000/api/mcp", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    const text = j.result.content[0].text;
    return { isError: !!j.result.isError, text, data: text.startsWith("{") ? JSON.parse(text) : null };
  }

  it("holdout 样本的标注隐藏正确值与备注（含修订历史）；dev 样本照常返回", async () => {
    const t = tok([...DIAGNOSE_SCOPES]);
    const hold = await call(t, "get_annotations", { run_id: holdRun.run_id });
    expect(hold.data.holdout).toBe(true);
    expect(hold.text).not.toContain("保留集的答案");
    expect(hold.text).not.toContain("保留集的备注");
    expect(hold.data.annotations[0]).toMatchObject({ assessment: "WRONG", expected_value: "（holdout 样本，已隐藏）" });
    const dev = await call(t, "get_annotations", { run_id: devRun.run_id });
    expect(dev.data.holdout).toBeUndefined();
    expect(dev.text).toContain("之后改的答案");
  });

  it("get_evaluation 写明所在数据集与分层；list_datasets 需要实验读权限，且不给 holdout 答案条数", async () => {
    const ev = await call(tok([...DIAGNOSE_SCOPES]), "get_evaluation", { run_id: holdRun.run_id });
    expect(ev.data.datasets.length).toBeGreaterThan(0);
    expect(ev.data.datasets[0]).toMatchObject({ split: "holdout", gold_annotations: null });
    expect((await call(tok([...DIAGNOSE_SCOPES]), "list_datasets", { prompt_id: "jiuli-p1" })).isError).toBe(true);
    const list = await call(tok([...DIAGNOSE_SCOPES, ...EXPERIMENT_SCOPES]), "list_datasets", { prompt_id: "jiuli-p1" });
    const sample = list.data.datasets[0].samples.find((s: { sample_id: string }) => s.sample_id === HOLD);
    expect(sample).toEqual({ sample_id: HOLD, split: "holdout", gold_annotations: null });
  });
});
