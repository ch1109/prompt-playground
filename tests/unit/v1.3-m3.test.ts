// v1.3 M3：正式版本、隔离候选、实验与评判、审批。真实模型与 Agent 的验收见 docs/audit/v1.3-gap-matrix.md。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { approveCandidate, createCandidate, evaluateExperiment, planExperiment, rejectCandidate, startExperiment } from "@/lib/experiments/service";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createGrant, READ_SCOPES, type Scope } from "@/lib/repositories/agent-access";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { getCandidate } from "@/lib/repositories/experiments";
import { createVersion, listVersions, stableHistory, stableVersionId } from "@/lib/repositories/prompts";
import { addAnnotation } from "@/lib/repositories/runs";
import { modelRun } from "@/lib/runs/service";

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-m3-mat-"));
});
afterEach(() => setProviderForTests(undefined));

describe("M3 正式版本", () => {
  it("首次读取时取当时最新版本为正式版本并留记录；之后保存新版本不改变正式版本", () => {
    const latest = listVersions("jiuli-p1")[0];
    expect(stableVersionId("jiuli-p1")).toBe(latest.version_id);
    expect(stableHistory("jiuli-p1")).toEqual([expect.objectContaining({ version_id: latest.version_id, previous_version_id: null, decided_by: "system" })]);
    const v = createVersion({ prompt_id: "jiuli-p1", label: "我的草稿", system_prompt: "S2", user_prompt_template: "{{input_json}}" });
    expect(listVersions("jiuli-p1")[0].version_id).toBe(v.version_id);
    expect(stableVersionId("jiuli-p1")).toBe(latest.version_id);
    expect(stableHistory("jiuli-p1")).toHaveLength(1);
  });

  it("正式版本变更记录只能追加", () => {
    expect(() => db().prepare("UPDATE prompt_stable_history SET note = 'x'").run()).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM prompt_stable_history").run()).toThrow(/只追加/);
  });
});

// —— 真实场景的模拟：基础版本让模型把 Source.column 写成数字（Schema 要求字符串），候选版本修好了 ——
const RAW = getFixture("v3/SC-08/P1")!.raw;
const RAW_NUMERIC_COLUMN = RAW.replace(/"column":\s*"([A-Z]+)"/g, (_m, c: string) => `"column": ${c.charCodeAt(0) - 64}`);
const FIX_LINE = "\nSource.column 必须是字符串（Excel 列字母，如 \"F\"），不能写成数字。";
const TARGET = "v3/SC-08/P1";
const REGRESSION = "v3/2026AG001-audit/P1";

let calls = 0;
/** 按提示词与样本决定输出：候选（含修复说明）→ 正常输出（可另行改写）；基础版本在目标样本上 → column 写成数字 */
function scenarioProvider(opts: { candidateRaw?: string; fail?: boolean } = {}) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-m3", timeoutMs: 2000 },
    (async (_u: string, init?: RequestInit) => {
      calls++;
      if (opts.fail) return new Response("rate limited", { status: 429 });
      const [system, user] = (JSON.parse(String(init?.body)).messages as { role: string; content: string }[]).map((m) => m.content);
      // 基础版本只在目标样本（SC-08）上出错，在回归样本上正常——与真实运行一致（ZW050 出错、AG001 正常）
      const raw = system.includes(FIX_LINE) ? (opts.candidateRaw ?? RAW) : user.includes("SC08-AUDIT-20260920-P1") ? RAW_NUMERIC_COLUMN : RAW;
      return Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    }) as unknown as typeof fetch,
  );
}

const baseVersion = () => listVersions("jiuli-p1").find((v) => v.label.startsWith("v3.0 原文"))!;
const newCandidate = (extra = "") =>
  createCandidate({ promptId: "jiuli-p1", baseVersionId: baseVersion().version_id, system: baseVersion().system_prompt + FIX_LINE + extra, userTemplate: baseVersion().user_prompt_template, reason: "诊断：Source.column 写成数字导致 SCHEMA_INVALID", createdBy: "test-agent" }).candidate;
const samples = [
  { sample_id: TARGET, role: "TARGET" as const },
  { sample_id: REGRESSION, role: "REGRESSION" as const },
];
const runCount = () => (db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;

describe("M3 候选", () => {
  it("候选是基础版本的隔离副本：不进版本列表、不动正式版本；与基础版本相同、缺 {{input_json}} 都拒绝", () => {
    const stable = stableVersionId("jiuli-p1");
    const versionsBefore = listVersions("jiuli-p1").length;
    const { candidate, diff } = createCandidate({ promptId: "jiuli-p1", baseVersionId: baseVersion().version_id, system: baseVersion().system_prompt + FIX_LINE, userTemplate: baseVersion().user_prompt_template, reason: "r", createdBy: "t" });
    expect(candidate.status).toBe("DRAFT");
    expect(JSON.stringify(diff.system)).toContain("Source.column 必须是字符串");
    expect(listVersions("jiuli-p1")).toHaveLength(versionsBefore);
    expect(stableVersionId("jiuli-p1")).toBe(stable);
    const same = { promptId: "jiuli-p1", baseVersionId: baseVersion().version_id, system: baseVersion().system_prompt, userTemplate: baseVersion().user_prompt_template, reason: "r", createdBy: "t" };
    expect(() => createCandidate(same)).toThrow(/完全相同/);
    expect(() => createCandidate({ ...same, system: "S2", userTemplate: "没有输入" })).toThrow(/input_json/);
  });

  it("候选内容不可修改、不可删除", () => {
    const c = newCandidate("（不可改）");
    expect(() => db().prepare("UPDATE prompt_candidates SET system_prompt = 'x' WHERE candidate_id = ?").run(c.candidate_id)).toThrow(/不可修改/);
    expect(() => db().prepare("DELETE FROM prompt_candidates WHERE candidate_id = ?").run(c.candidate_id)).toThrow(/不可删除/);
  });
});

describe("M3 实验与评判", () => {
  it("超出调用上限时在调用模型之前拒绝；没有目标样本也拒绝", () => {
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（预算）");
    const before = runCount();
    expect(() => planExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 3, reuseBaseline: false })).toThrow(/需要调用模型 4 次/);
    expect(() => planExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 21 })).toThrow(/最多调用模型 20 次/);
    expect(() => planExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: REGRESSION, role: "REGRESSION" }], maxModelRuns: 5 })).toThrow(/目标样本/);
    expect(runCount()).toBe(before);
  });

  it("EXP-01/03 目标样本结构错误被修好、回归样本无变化：可供人审；正式版本不变；已有基线被复用", async () => {
    setProviderForTests(scenarioProvider());
    // 先用基础版本在目标样本上真实跑一次（结构不符），作为可复用的基线
    const snap = snapshotForFixture("jiuli", getFixture(TARGET)!)!;
    const baseline = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: baseVersion().system_prompt, userTemplate: baseVersion().user_prompt_template, promptVersionId: baseVersion().version_id, params: { temperature: 0 } });
    expect(baseline.status).toBe("SCHEMA_INVALID");
    const stable = stableVersionId("jiuli-p1");
    const c = newCandidate("（实验一）");
    calls = 0;
    const { experiment, done } = startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "test-agent" });
    expect(experiment.samples[0]).toMatchObject({ baseline_run_id: baseline.run_id, baseline_reused: true });
    expect(experiment.budget.planned_model_runs).toBe(3);
    const exp = await done;
    expect(calls).toBe(3);
    expect(exp).toMatchObject({ status: "COMPLETED", budget: { used_model_runs: 3 } });
    const r = exp.report!;
    expect(r.samples[0]).toMatchObject({ sample_id: TARGET, verdict: "FIXED", structure: { change: "FIXED", candidate_errors: 0 }, comparability: { comparable: true } });
    expect(r.samples[1]).toMatchObject({ sample_id: REGRESSION, verdict: "NO_CHANGE" });
    expect(r.conclusion).toBe("READY_FOR_REVIEW");
    expect(stableVersionId("jiuli-p1")).toBe(stable);
  });

  it("EXP-03 人工标为「对」的字段被候选改掉：判为退化，结论不建议", async () => {
    setProviderForTests(scenarioProvider({ candidateRaw: RAW.replace('"origin": "韩国"', '"origin": "日本"') }));
    const regSnap = snapshotForFixture("jiuli", getFixture(REGRESSION)!)!;
    const base = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: regSnap.snapshot_id, system: baseVersion().system_prompt, userTemplate: baseVersion().user_prompt_template, promptVersionId: baseVersion().version_id, params: { temperature: 0 } });
    addAnnotation({ run_id: base.run_id, target_json_pointer: "/output/rows/0/values/origin", target: "row-1 / origin", issue_type: "ASSESSMENT", expected_value: null, note: null, assessment: "CORRECT", error_category: null, model_value: JSON.stringify("韩国") });
    const c = newCandidate("（会改坏产地）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    const reg = exp.report!.samples.find((s) => s.sample_id === REGRESSION)!;
    expect(reg.verdict).toBe("REGRESSED");
    expect(reg.annotated_fields).toEqual([expect.objectContaining({ outcome: "REGRESSED", baseline_value: "韩国", candidate_value: "日本" })]);
    expect(exp.report!.conclusion).toBe("NOT_RECOMMENDED");
  });

  it("EXP-10 同一幂等键重复提交：返回同一个实验，不再调用模型", async () => {
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（幂等）");
    const first = startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t", idempotencyKey: "key-1" });
    await first.done;
    const before = runCount();
    const again = startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t", idempotencyKey: "key-1" });
    expect(again).toMatchObject({ reused: true, experiment: { experiment_id: first.experiment.experiment_id } });
    expect(runCount()).toBe(before);
  });

  it("模型调用失败：样本记为没跑完，结论是证据不足，不会判成修好", async () => {
    setProviderForTests(scenarioProvider({ fail: true }));
    const c = newCandidate("（失败）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    expect(exp.report!.samples.every((s) => s.verdict === "INCOMPLETE")).toBe(true);
    expect(exp.report!.conclusion).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("M3 人工审批", () => {
  it("EXP-08 采纳：生成新版本并移动正式版本、留记录；没有完成的实验不能采纳", async () => {
    const noExp = newCandidate("（没实验）");
    expect(() => approveCandidate({ candidateId: noExp.candidate_id, label: "x", decidedBy: "我" })).toThrow(/还没有完成的实验/);
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（采纳）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    expect(exp.report!.conclusion).toBe("READY_FOR_REVIEW");
    const prevStable = stableVersionId("jiuli-p1");
    const r = approveCandidate({ candidateId: c.candidate_id, label: "v3.0-fix 采纳候选", decidedBy: "我", note: "看过 Diff 与报告" });
    expect(r.previous_stable_version_id).toBe(prevStable);
    expect(stableVersionId("jiuli-p1")).toBe(r.version.version_id);
    expect(r.version).toMatchObject({ parent_version_id: baseVersion().version_id, system_prompt: c.system_prompt });
    expect(stableHistory("jiuli-p1")[0]).toMatchObject({ version_id: r.version.version_id, previous_version_id: prevStable, candidate_id: c.candidate_id, experiment_id: exp.experiment_id, decided_by: "我" });
    expect(getCandidate(c.candidate_id)).toMatchObject({ status: "APPROVED", promoted_version_id: r.version.version_id });
    expect(() => approveCandidate({ candidateId: c.candidate_id, label: "again", decidedBy: "我" })).toThrow(/已采纳或已拒绝/);
  });

  it("结论不是「可供人审」时，不确认风险就不能采纳", async () => {
    setProviderForTests(scenarioProvider({ fail: true }));
    const c = newCandidate("（证据不足）");
    await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    expect(() => approveCandidate({ candidateId: c.candidate_id, label: "x", decidedBy: "我" })).toThrow(/INSUFFICIENT_EVIDENCE/);
  });

  it("EXP-09 拒绝：正式版本不变，候选与实验历史保留", async () => {
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（拒绝）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    const stable = stableVersionId("jiuli-p1");
    expect(rejectCandidate({ candidateId: c.candidate_id, decidedBy: "我", note: "不需要" }).status).toBe("REJECTED");
    expect(stableVersionId("jiuli-p1")).toBe(stable);
    expect(evaluateExperiment(exp.experiment_id).report!.conclusion).toBe("READY_FOR_REVIEW");
    expect(() => startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" })).toThrow(/已采纳或已拒绝/);
  });
});

describe("M3 MCP 实验工具", () => {
  const ALL = [...READ_SCOPES, "experiments:read", "experiments:write", "experiments:execute"] as Scope[];
  const tok = (scopes: Scope[] = ALL, customerIds?: string[]) => createGrant({ principal: "agent-m3", projectIds: ["jiuli"], scopes, customerIds }).token;
  const rpc = async (t: string, method: string, params?: unknown) => {
    const res = await POST(new Request("http://localhost:3000/api/mcp", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    return (await res.json()) as { result: { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; isError?: boolean; content?: { text: string }[] } };
  };
  const call = async (t: string, name: string, args: Record<string, unknown>) => {
    const r = (await rpc(t, "tools/call", { name, arguments: args })).result;
    return { isError: !!r.isError, data: JSON.parse(r.content![0].text) };
  };
  const firstLine = () => baseVersion().system_prompt.split("\n")[0];

  it("默认只读令牌看不到实验工具；带实验权限的令牌多 3 个工具，但没有任何采纳 / 改正式版本的工具", async () => {
    expect((await rpc(tok([...READ_SCOPES]), "tools/list")).result.tools).toHaveLength(8);
    const tools = (await rpc(tok(), "tools/list")).result.tools!;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["create_prompt_candidate", "run_experiment", "evaluate_experiment"]));
    expect(tools).toHaveLength(11);
    expect(tools.some((t) => /approve|promote|stable|publish/i.test(t.name))).toBe(false);
  });

  it("create_prompt_candidate：按查找 → 替换生成候选；find 找不到或不唯一都拒绝", async () => {
    const t = tok();
    const ok = await call(t, "create_prompt_candidate", { base_prompt_version_id: baseVersion().version_id, edits: [{ find: firstLine(), replace: firstLine() + FIX_LINE }], reason: "Source.column 写成数字", diagnosis_ref: "run_x#/output" });
    expect(ok.isError).toBe(false);
    expect(getCandidate(ok.data.candidate_id)).toMatchObject({ status: "DRAFT", created_by: "agent-m3", system_prompt: expect.stringContaining(FIX_LINE) });
    expect((await call(t, "create_prompt_candidate", { base_prompt_version_id: baseVersion().version_id, edits: [{ find: "不存在的一句话", replace: "x" }], reason: "r" })).data.error.code).toBe("EDIT_NOT_FOUND");
    expect((await call(t, "create_prompt_candidate", { base_prompt_version_id: baseVersion().version_id, edits: [{ find: "，", replace: "," }], reason: "r" })).data.error.code).toBe("EDIT_AMBIGUOUS");
  });

  it("run_experiment：dry_run 不花钱；正式运行后 evaluate_experiment 拿到报告；正式版本不变", async () => {
    setProviderForTests(scenarioProvider());
    const t = tok();
    const cand = (await call(t, "create_prompt_candidate", { base_prompt_version_id: baseVersion().version_id, edits: [{ find: firstLine(), replace: firstLine() + FIX_LINE + "（MCP）" }], reason: "r" })).data;
    const before = runCount();
    const dry = await call(t, "run_experiment", { candidate_id: cand.candidate_id, samples, max_model_runs: 4, dry_run: true });
    expect(dry.data).toMatchObject({ dry_run: true, planned_model_runs: expect.any(Number) });
    expect(runCount()).toBe(before);
    const stable = stableVersionId("jiuli-p1");
    const started = await call(t, "run_experiment", { candidate_id: cand.candidate_id, samples, max_model_runs: 4, idempotency_key: "mcp-1" });
    expect(started.data.status).toBe("RUNNING");
    let ev;
    for (let i = 0; i < 100; i++) {
      ev = (await call(t, "evaluate_experiment", { experiment_id: started.data.experiment_id })).data;
      if (ev.experiment.status !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ev.experiment.status).toBe("COMPLETED");
    expect(ev.report.conclusion).toBe("READY_FOR_REVIEW");
    expect(ev.report.samples[0]).toMatchObject({ role: "TARGET", verdict: "FIXED" });
    expect(stableVersionId("jiuli-p1")).toBe(stable);
    // 同一幂等键：返回同一实验
    expect((await call(t, "run_experiment", { candidate_id: cand.candidate_id, samples, max_model_runs: 4, idempotency_key: "mcp-1" })).data).toMatchObject({ experiment_id: started.data.experiment_id, reused_existing: true });
  });

  it("客户受限的令牌不能在别的客户的样本上做实验；超预算在调用模型前拒绝", async () => {
    setProviderForTests(scenarioProvider());
    const cand = (await call(tok(), "create_prompt_candidate", { base_prompt_version_id: baseVersion().version_id, edits: [{ find: firstLine(), replace: firstLine() + FIX_LINE + "（客户）" }], reason: "r" })).data;
    const before = runCount();
    expect((await call(tok(ALL, ["C-someone-else"]), "run_experiment", { candidate_id: cand.candidate_id, samples, max_model_runs: 4 })).data.error.code).toBe("FORBIDDEN");
    expect((await call(tok(), "run_experiment", { candidate_id: cand.candidate_id, samples, max_model_runs: 1 })).data.error.code).toBe("BUDGET_EXCEEDED");
    expect(runCount()).toBe(before);
  });
});
