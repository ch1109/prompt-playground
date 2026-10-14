// v1.3 §11 / §14 M4：自动优化会话服务——预检、诊断推动、每轮候选与试运行、预算、停止条件、取消、超时、审批联动
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { createGrant, DIAGNOSE_SCOPES, EXPERIMENT_SCOPES, listAudit } from "@/lib/repositories/agent-access";
import type { Run } from "@/lib/contracts/run";
import { submitDiagnosis } from "@/lib/diagnoses/report";
import { approveCandidate } from "@/lib/experiments/service";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { cancelSession, createSession, createSessionCandidate, loadSession, onCandidateDecided, onSessionDiagnosis, startSessionExperiment } from "@/lib/optimization/service";
import { resetDbForTests } from "@/lib/repositories/db";
import { getDataset } from "@/lib/repositories/datasets";
import { getExperiment } from "@/lib/repositories/experiments";
import { getSession, listEvents, saveSession } from "@/lib/repositories/optimizations";
import { getVersion, stableVersionId } from "@/lib/repositories/prompts";
import { addAnnotation } from "@/lib/repositories/runs";
import { loadRunContext } from "@/lib/runs/debug-bundle";
import { modelRun } from "@/lib/runs/service";

const TARGET = "v3/SC-08/P1";
const REGRESSION = "v3/2026AG001-audit/P1";
const RAW = getFixture(TARGET)!.raw;
/** 基础版本在目标样本上把 Source.column 写成数字（结构不符） */
const RAW_BROKEN = RAW.replace(/"column":\s*"([A-Z]+)"/g, (_m, c: string) => `"column": ${c.charCodeAt(0) - 64}`);
/** 少了一行（P1 漏行 = 九立硬规则闸门） */
const RAW_MISSING_ROW = (() => {
  const j = JSON.parse(RAW);
  j.output.rows = j.output.rows.slice(0, 1);
  return JSON.stringify(j);
})();

/** 按候选里的标记决定输出；slowMs > 0 时模拟慢调用（可被取消） */
function provider(slowMs = 0) {
  return new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-opt", timeoutMs: 5000 }, ((_u: string, init?: RequestInit) => {
    const [system, user] = (JSON.parse(String(init?.body)).messages as { content: string }[]).map((m) => m.content);
    const onTarget = user.includes("SC08-AUDIT-20260920-P1");
    const raw = system.includes("【修好】") ? RAW : system.includes("【漏行】") ? RAW_MISSING_ROW : onTarget ? RAW_BROKEN : RAW;
    const body = Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    if (!slowMs) return Promise.resolve(body);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(body), slowMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as unknown as typeof fetch);
}

let targetRun: Run;
const POINTER = "/output/rows/0/values/origin";
const base = () => getVersion(stableVersionId("jiuli-p1")!)!;
const firstLine = () => base().system_prompt.split("\n")[0];

beforeAll(async () => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-opt-mat-"));
  setProviderForTests(provider());
  const snap = snapshotForFixture("jiuli", getFixture(TARGET)!)!;
  targetRun = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: base().system_prompt, userTemplate: base().user_prompt_template, promptVersionId: base().version_id, params: { temperature: 0 } });
  setProviderForTests(undefined);
  addAnnotation({ run_id: targetRun.run_id, target_json_pointer: POINTER, target: "orderRows / row-1 / origin", issue_type: "ASSESSMENT", expected_value: "日本", note: null, assessment: "WRONG", error_category: "UNKNOWN", category_confirmed: null, model_value: null, source_ref_ids: [], author: "我" });
});
afterEach(() => setProviderForTests(undefined));

const start = (o: { maxModelRuns?: number; maxIterations?: number } = {}) => createSession({ runId: targetRun.run_id, jsonPointer: POINTER, regressionSamples: [REGRESSION], maxModelRuns: o.maxModelRuns ?? 20, maxIterations: o.maxIterations, createdBy: "我" });
const diagnose = (sessionId: string, category: string, result_status = "CONFIRMED") => {
  const d = submitDiagnosis({
    ctx: loadRunContext(targetRun.run_id)!,
    objectRef: { json_pointer: POINTER },
    report: {
      observed_problem: "问题",
      verified_facts: ["事实"],
      root_cause: { category, summary: "根因", supporting_evidence_refs: [`${targetRun.run_id}#trace/raw_response`] },
      proposed_change: { target_layer: "PROMPT", action_type: "EDIT_PROMPT_RULE", summary: "改提示词" },
      impact_scope: "P1",
      verification_plan: "试运行",
      result_status,
    },
    createdBy: "agent",
    loadRun: (id) => loadRunContext(id)!,
  });
  return onSessionDiagnosis(sessionId, d, "agent");
};
const candidate = (sessionId: string, marker: string) => createSessionCandidate({ sessionId, baseVersionId: base().version_id, edits: [{ find: firstLine(), replace: `${firstLine()}${marker}${Math.random()}` }], reason: "测试", actor: "agent" });
/** 等试运行结束、会话离开 EXPERIMENTING */
async function settle(sessionId: string) {
  for (let i = 0; i < 200 && getSession(sessionId)!.status === "EXPERIMENTING"; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
  return loadSession(sessionId);
}
/** 跑一轮：建候选 → 试运行 → 等结果 */
async function round(sessionId: string, marker: string) {
  const c = candidate(sessionId, marker);
  startSessionExperiment({ sessionId, candidateId: c.candidate.candidate_id, actor: "agent" });
  return settle(sessionId);
}

describe("开始自动优化", () => {
  it("没标「错」、没选回归样本、预算没填或超上限都拒绝", () => {
    expect(() => createSession({ runId: targetRun.run_id, jsonPointer: "/output/rows/1/values/origin", regressionSamples: [REGRESSION], maxModelRuns: 10, createdBy: "我" })).toThrow(/还没有标「错」/);
    expect(() => start({ maxModelRuns: 0 })).toThrow(/必须填写/);
    expect(() => start({ maxModelRuns: 61 })).toThrow(/最多调用模型 60 次/);
    expect(() => start({ maxIterations: 6 })).toThrow(/1–5/);
    expect(() => createSession({ runId: targetRun.run_id, jsonPointer: POINTER, regressionSamples: [TARGET], maxModelRuns: 10, createdBy: "我" })).toThrow(/回归样本/);
  });

  it("自动建数据集版本（目标 dev、回归 regression，冻结标注），预检通过后等 Agent 诊断；同一提示词同时只能有一个", () => {
    const s = start();
    expect(s.status).toBe("DIAGNOSING");
    const ds = getDataset(s.dataset.dataset_id, s.dataset.version)!;
    expect(ds.samples.map((x) => [x.sample_id, x.split])).toEqual([
      [TARGET, "dev"],
      [REGRESSION, "regression"],
    ]);
    expect(ds.samples[0].gold[0]).toMatchObject({ expected_value: "日本" });
    expect(s.objective).toMatchObject({ sample_id: TARGET, json_pointer: POINTER, table_id: "orderRows", row_id: "row-1", field: "origin" });
    expect(listEvents(s.session_id).map((e) => e.to_status)).toEqual(["CREATED", "EVIDENCE_CHECK", "DIAGNOSING"]);
    expect(() => start()).toThrow(/已有进行中的自动优化/);
    cancelSession(s.session_id, "我");
  });
});

describe("诊断推动状态", () => {
  it("非提示词根因 → 停在 NON_PROMPT_ISSUE（EXP-07），并写明建议", () => {
    const s = diagnose(start().session_id, "PREPROCESSING_ERROR");
    expect(s).toMatchObject({ status: "NON_PROMPT_ISSUE", outcome_note: expect.stringMatching(/不是提示词能解决/) });
  });
  it("证据不足 → BLOCKED", () => {
    expect(diagnose(start().session_id, "PROMPT_RULE_ERROR", "NEEDS_MORE_EVIDENCE").status).toBe("BLOCKED");
  });
  it("没诊断就建候选被拒绝", () => {
    const s = start();
    expect(() => candidate(s.session_id, "【修好】")).toThrow(/不能创建候选/);
    cancelSession(s.session_id, "我");
  });
});

describe("每轮循环", () => {
  it("硬规则变差（漏行）→ 立即停止 HARD_REGRESSION，不记为最佳", async () => {
    setProviderForTests(provider());
    const s = await round(diagnose(start().session_id, "PROMPT_RULE_ERROR").session_id, "【漏行】");
    expect(s).toMatchObject({ status: "STOPPED", stop_reason: "HARD_REGRESSION", best: null });
  });

  it("每轮只能一个候选、必须基于会话的基础版本；连续没进展 → NO_PROGRESS", async () => {
    setProviderForTests(provider());
    const s0 = diagnose(start({ maxIterations: 5 }).session_id, "PROMPT_RULE_ERROR");
    expect(() => createSessionCandidate({ sessionId: s0.session_id, baseVersionId: "pv_other", edits: [{ find: firstLine(), replace: "x" }], reason: "r", actor: "agent" })).toThrow(/基于/);
    candidate(s0.session_id, "【无效】");
    expect(() => candidate(s0.session_id, "【无效】")).toThrow(/还没试运行/);
    const c1 = loadSession(s0.session_id).rounds[0].candidate_id;
    startSessionExperiment({ sessionId: s0.session_id, candidateId: c1, actor: "agent" });
    let s = await settle(s0.session_id);
    expect(s).toMatchObject({ status: "CANDIDATE_DRAFT", no_progress: 0, best: { iteration: 1, score: 0 } });
    s = await round(s.session_id, "【无效】");
    expect(s).toMatchObject({ status: "CANDIDATE_DRAFT", no_progress: 1 });
    s = await round(s.session_id, "【无效】");
    expect(s).toMatchObject({ status: "STOPPED", stop_reason: "NO_PROGRESS", best: { iteration: 1 } });
  });

  it("轮数用完 → MAX_ITERATIONS", async () => {
    setProviderForTests(provider());
    const s = await round(diagnose(start({ maxIterations: 1 }).session_id, "PROMPT_RULE_ERROR").session_id, "【无效】");
    expect(s).toMatchObject({ status: "STOPPED", stop_reason: "MAX_ITERATIONS" });
  });

  it("剩余调用不够下一轮 → BUDGET_EXHAUSTED（EXP-05）；不够跑这一轮时在调用模型前拒绝", async () => {
    setProviderForTests(provider());
    const s = await round(diagnose(start({ maxModelRuns: 3 }).session_id, "PROMPT_RULE_ERROR").session_id, "【无效】");
    expect(s).toMatchObject({ status: "STOPPED", stop_reason: "BUDGET_EXHAUSTED" });
    expect(s.budget.used_model_runs).toBeLessThanOrEqual(3);
    const tight = diagnose(start({ maxModelRuns: 1 }).session_id, "PROMPT_RULE_ERROR");
    const c = candidate(tight.session_id, "【修好】");
    expect(() => startSessionExperiment({ sessionId: tight.session_id, candidateId: c.candidate.candidate_id, actor: "agent" })).toThrow(/会话剩余 1 次调用/);
    cancelSession(tight.session_id, "我");
  });

  it("试运行进行中取消：停掉试运行，会话 STOPPED（CANCELED），已完成的运行保留", async () => {
    setProviderForTests(provider(300));
    const s0 = diagnose(start().session_id, "PROMPT_RULE_ERROR");
    const c = candidate(s0.session_id, "【修好】");
    const { experiment } = startSessionExperiment({ sessionId: s0.session_id, candidateId: c.candidate.candidate_id, actor: "agent" });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelSession(s0.session_id, "我")).toMatchObject({ status: "STOPPED", stop_reason: "CANCELED" });
    for (let i = 0; i < 100 && getExperiment(experiment!.experiment_id)!.status === "RUNNING"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(getExperiment(experiment!.experiment_id)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/已取消/) });
    expect(loadSession(s0.session_id).status).toBe("STOPPED");
  });

  it("超过会话时限 → 读取时停为 TIMEOUT", () => {
    const s = start();
    s.deadline = new Date(Date.now() - 1000).toISOString();
    saveSession(s);
    expect(loadSession(s.session_id)).toMatchObject({ status: "STOPPED", stop_reason: "TIMEOUT" });
  });

  it("经 MCP 跑完一个会话：脚本化的 Agent 只用工具完成诊断 → 候选 → 试运行，会话达标后等人审批；只有诊断权限的令牌不能推动会话", async () => {
    setProviderForTests(provider());
    const s = start();
    const tok = (scopes: string[]) => createGrant({ principal: "agent-opt", projectIds: ["jiuli"], scopes: scopes as never }).token;
    const call = async (t: string, name: string, args: Record<string, unknown>) => {
      const res = await POST(
        new Request("http://127.0.0.1:3000/api/mcp", {
          method: "POST",
          headers: { host: "127.0.0.1:3000", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      const text = j.result.content[0].text;
      return { isError: !!j.result.isError, data: text.startsWith("{") ? JSON.parse(text) : text };
    };
    const report = { observed_problem: "结构不符", verified_facts: ["column 写成了数字"], root_cause: { category: "PROMPT_RULE_ERROR", summary: "提示词没写 column 格式", supporting_evidence_refs: [`${targetRun.run_id}#trace/raw_response`] }, proposed_change: { target_layer: "PROMPT", action_type: "EDIT_PROMPT_RULE", summary: "补一句" }, impact_scope: "P1", verification_plan: "试运行", result_status: "CONFIRMED" };

    const readOnly = tok([...DIAGNOSE_SCOPES]);
    expect((await call(readOnly, "submit_diagnosis_report", { run_id: targetRun.run_id, object_ref: { json_pointer: POINTER }, report, session_id: s.session_id })).data.error.code).toBe("FORBIDDEN");
    expect(listAudit(1)[0]).toMatchObject({ tool: "submit_diagnosis_report", outcome: "DENIED" });
    expect(loadSession(s.session_id).status).toBe("DIAGNOSING");

    const agent = tok([...DIAGNOSE_SCOPES, ...EXPERIMENT_SCOPES]);
    const view = await call(agent, "get_optimization_session", { session_id: s.session_id });
    expect(view.data).toMatchObject({ status: "DIAGNOSING", base_version_id: base().version_id, remaining_model_runs: 20, next_action: expect.stringMatching(/submit_diagnosis_report/) });
    const diag = await call(agent, "submit_diagnosis_report", { run_id: targetRun.run_id, object_ref: { json_pointer: POINTER }, report, session_id: s.session_id });
    expect(diag.data.session.status).toBe("CANDIDATE_DRAFT");
    const cand = await call(agent, "create_prompt_candidate", { base_prompt_version_id: base().version_id, edits: [{ find: firstLine(), replace: `${firstLine()}【修好】` }], reason: "补 column 格式", session_id: s.session_id });
    expect(cand.data.session.rounds).toHaveLength(1);
    const dry = await call(agent, "run_experiment", { candidate_id: cand.data.candidate_id, session_id: s.session_id, dry_run: true });
    expect(dry.data).toMatchObject({ dry_run: true, experiment_id: null, planned_model_runs: expect.any(Number) });
    const run = await call(agent, "run_experiment", { candidate_id: cand.data.candidate_id, session_id: s.session_id });
    expect(run.data.experiment_id).toMatch(/^exp_/);
    await settle(s.session_id);
    const done = await call(agent, "get_optimization_session", { session_id: s.session_id });
    expect(done.data).toMatchObject({ status: "READY_FOR_REVIEW", best: { candidate_id: cand.data.candidate_id }, next_action: expect.stringMatching(/等人在网页上审批/) });
    expect((await call(agent, "create_prompt_candidate", { base_prompt_version_id: base().version_id, edits: [{ find: firstLine(), replace: "x" }], reason: "r", session_id: s.session_id })).data.error.code).toBe("SESSION_STATE");
    onCandidateDecided(cand.data.candidate_id, "REJECTED", "我");
    expect(loadSession(s.session_id).status).toBe("REJECTED");
  });

  // 放在最后：采纳会移动正式版本（带【修好】标记），之后的轮次都会继承它
  it("达标 → 等人审批；采纳最佳候选后会话为 APPROVED，正式版本移动", async () => {
    setProviderForTests(provider());
    const s0 = diagnose(start().session_id, "PROMPT_RULE_ERROR");
    expect(s0.status).toBe("CANDIDATE_DRAFT");
    const s = await round(s0.session_id, "【修好】");
    expect(s).toMatchObject({ status: "READY_FOR_REVIEW", best: { iteration: 1 } });
    expect(s.rounds[0]).toMatchObject({ conclusion: "READY_FOR_REVIEW", model_runs: expect.any(Number) });
    expect(s.budget.used_model_runs).toBe(s.rounds[0].model_runs);
    expect(() => cancelSession(s.session_id, "我")).toThrow(/采纳或拒绝/);
    const before = stableVersionId("jiuli-p1");
    await approveCandidate({ candidateId: s.best!.candidate_id, label: "自动优化采纳", decidedBy: "我" });
    onCandidateDecided(s.best!.candidate_id, "APPROVED", "我");
    expect(loadSession(s.session_id).status).toBe("APPROVED");
    expect(stableVersionId("jiuli-p1")).not.toBe(before);
  });
});
