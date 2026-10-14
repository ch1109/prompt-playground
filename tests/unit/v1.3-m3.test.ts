// v1.3 M3：正式版本、隔离候选、实验与评判、审批。真实模型与 Agent 的验收见 docs/audit/v1.3-gap-matrix.md。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
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
function scenarioProvider(opts: { candidateRaw?: string; baseRaw?: string; fail?: boolean } = {}) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-m3", timeoutMs: 2000 },
    (async (_u: string, init?: RequestInit) => {
      calls++;
      if (opts.fail) return new Response("rate limited", { status: 429 });
      const [system, user] = (JSON.parse(String(init?.body)).messages as { role: string; content: string }[]).map((m) => m.content);
      // 基础版本只在目标样本（SC-08）上出错，在回归样本上正常——与真实运行一致（ZW050 出错、AG001 正常）
      const raw = system.includes(FIX_LINE) ? (opts.candidateRaw ?? RAW) : user.includes("SC08-AUDIT-20260920-P1") ? RAW_NUMERIC_COLUMN : (opts.baseRaw ?? RAW);
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
    await expect(approveCandidate({ candidateId: noExp.candidate_id, label: "x", decidedBy: "我" })).rejects.toThrow(/还没有完成的实验/);
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（采纳）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    expect(exp.report!.conclusion).toBe("READY_FOR_REVIEW");
    const prevStable = stableVersionId("jiuli-p1");
    const r = await approveCandidate({ candidateId: c.candidate_id, label: "v3.0-fix 采纳候选", decidedBy: "我", note: "看过 Diff 与报告" });
    expect(r.previous_stable_version_id).toBe(prevStable);
    expect(stableVersionId("jiuli-p1")).toBe(r.version.version_id);
    expect(r.version).toMatchObject({ parent_version_id: baseVersion().version_id, system_prompt: c.system_prompt });
    expect(stableHistory("jiuli-p1")[0]).toMatchObject({ version_id: r.version.version_id, previous_version_id: prevStable, candidate_id: c.candidate_id, experiment_id: exp.experiment_id, decided_by: "我" });
    expect(getCandidate(c.candidate_id)).toMatchObject({ status: "APPROVED", promoted_version_id: r.version.version_id });
    await expect(approveCandidate({ candidateId: c.candidate_id, label: "again", decidedBy: "我" })).rejects.toThrow(/已采纳或已拒绝/);
  });

  it("结论不是「可供人审」时，不确认风险就不能采纳", async () => {
    setProviderForTests(scenarioProvider({ fail: true }));
    const c = newCandidate("（证据不足）");
    await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    await expect(approveCandidate({ candidateId: c.candidate_id, label: "x", decidedBy: "我" })).rejects.toThrow(/INSUFFICIENT_EVIDENCE/);
  });

  it("EXP-09 拒绝：正式版本不变，候选与实验历史保留", async () => {
    setProviderForTests(scenarioProvider());
    const c = newCandidate("（拒绝）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples, maxModelRuns: 4, createdBy: "t" }).done;
    const stable = stableVersionId("jiuli-p1");
    expect(rejectCandidate({ candidateId: c.candidate_id, decidedBy: "我", note: "不需要" }).status).toBe("REJECTED");
    expect(stableVersionId("jiuli-p1")).toBe(stable);
    expect((await evaluateExperiment(exp.experiment_id)).report!.conclusion).toBe("READY_FOR_REVIEW");
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

  it("默认只读令牌看不到实验工具；带实验权限的令牌多 4 个工具（含只读的 list_datasets），但没有任何采纳 / 改正式版本的工具", async () => {
    expect((await rpc(tok([...READ_SCOPES]), "tools/list")).result.tools).toHaveLength(9);
    const tools = (await rpc(tok(), "tools/list")).result.tools!;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["create_prompt_candidate", "run_experiment", "evaluate_experiment", "list_datasets"]));
    expect(tools).toHaveLength(13);
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

describe("M3 服务重启", () => {
  it("运行中的实验在服务重启后标为失败（说明原因），不会永远停在运行中", async () => {
    const { markInterruptedRuns } = await import("@/lib/repositories/db");
    const { insertExperiment, getExperiment } = await import("@/lib/repositories/experiments");
    const c = newCandidate("（重启）");
    insertExperiment({ experiment_id: "exp_restart", candidate_id: c.candidate_id, prompt_id: "jiuli-p1", project_id: "jiuli", idempotency_key: null, status: "RUNNING", created_by: "t", created_at: new Date().toISOString(), finished_at: null, base_version_id: baseVersion().version_id, model: "m", budget: { max_model_runs: 2, planned_model_runs: 2, used_model_runs: 1 }, samples: [], report: null, error: null });
    markInterruptedRuns();
    expect(getExperiment("exp_restart")).toMatchObject({ status: "FAILED", error: expect.stringMatching(/重启/), finished_at: expect.any(String) });
  });
});

describe("来源坐标检查（打开原件核对）", () => {
  it("候选把来源指到原件里空着的格子：判为退化（比基线多出一处指错）", async () => {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const ws = XLSX.utils.aoa_to_sheet([[], [], [], [], [], ["序号", "货物名称", "品牌", "型号", "参数", "产地"], [1, "晶圆", "SK HYNIX", "H25G9TCXXCX702A#9", "64GB", "韩国"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "12-10-2");
    const snap = await createFileSnapshot({ projectId: "jiuli", files: [{ name: "委托.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, materialType: "ORDER" }] });
    const raw = RAW.replaceAll("F-3c3cc10bd26b", snap.materials[0].file_id);
    // 候选：产地的来源从第 7 行 F 列（「韩国」）改指到第 4 行 F 列（空格子）
    const moved = raw.replace('"row": 7, "column": "F", "raw_text": "韩国"', '"row": 4, "column": "F", "raw_text": "韩国"');
    expect(moved).not.toBe(raw);
    setProviderForTests(scenarioProvider({ candidateRaw: moved, baseRaw: raw }));
    const base = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: baseVersion().system_prompt, userTemplate: baseVersion().user_prompt_template, promptVersionId: baseVersion().version_id, params: { temperature: 0 } });
    expect(base.status).toBe("SUCCEEDED");
    const c = newCandidate("（来源坐标）");
    const exp = await startExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: snap.snapshot_id, role: "TARGET" }, { sample_id: TARGET, role: "REGRESSION" }], maxModelRuns: 4, createdBy: "t" }).done;
    const s = exp.report!.samples[0];
    // 测试用的 Excel 只有两行，基线与候选在其他格子上的「对不上」一样多；多出来的正是改动的那一处
    expect(s.source_check!.worse).toBe(true);
    expect(s.source_check!.candidate_problems).toEqual(expect.arrayContaining([expect.objectContaining({ where: "「12-10-2」第 4 行 F 列", claimed: "韩国", actual: null })]));
    expect(s.source_check!.candidate!.wrong).toBe(s.source_check!.baseline!.wrong + 1);
    expect(s.verdict).toBe("REGRESSED");
    expect(exp.report!.conclusion).toBe("NOT_RECOMMENDED");
  });
});

describe("P3 / P4 业务硬规则", () => {
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const load = (id: string) => {
    const f = getFixture(id)!;
    return { request: clone(f.request) as any, out: JSON.parse(f.raw) as any };
  };
  const rules = (vs: { rule: string }[]) => vs.map((x) => x.rule);

  it("真实录制的 P3 / P4 输出没有违反；逐条改坏后各自被抓到", async () => {
    const { p3Violations, p4Violations } = await import("@/lib/experiments/business-rules");
    const p3 = load("v3/SC-08/P3");
    expect(p3Violations(p3.request, p3.out)).toEqual([]);
    const raw0 = p3.out.output.row_relations[0].selected_raw_row_ids[0];
    // 跨客户
    const cross = clone(p3);
    cross.request.input.inspection_candidates.find((c: any) => c.raw_row_id === raw0).customer_id = "C-other";
    expect(rules(p3Violations(cross.request, cross.out))).toContain("P3_CROSS_CUSTOMER");
    // 已被别的委托行占用
    const occ = clone(p3);
    occ.request.input.inspection_candidates.find((c: any) => c.raw_row_id === raw0).occupied_by_order_row_id = "D-someone-else";
    expect(rules(p3Violations(occ.request, occ.out))).toContain("P3_OCCUPIED_REUSED");
    // 同一查货行分给两个委托行
    const twice = clone(p3);
    twice.out.output.row_relations[1].match_status = "MATCHED";
    twice.out.output.row_relations[1].selected_raw_row_ids = [raw0];
    expect(rules(p3Violations(twice.request, twice.out))).toContain("P3_RAW_ROW_REUSED");
    // 没有身份证据（只剩数量 / 范围）
    const qty = clone(p3);
    qty.out.output.row_relations[0].evidence_keys = qty.out.output.row_relations[0].evidence_keys.filter((k: string) => !/MODEL|MARKER/.test(k));
    expect(rules(p3Violations(qty.request, qty.out))).toContain("P3_NO_IDENTITY_EVIDENCE");

    const p4 = load("v3/SC-08/P4");
    expect(p4Violations(p4.request, p4.out)).toEqual([]);
    const fields = p4.request.input.target_rows[0].fields;
    const decision = (o: any, f: string) => o.out.output.row_patches[0].field_decisions.find((d: any) => d.field === f);
    // 锁定字段被改
    const locked = clone(p4);
    locked.request.input.target_rows[0].fields.brand.write_policy = "LOCKED";
    Object.assign(decision(locked, "brand"), { decision: "UPDATE", result_value: "SKH" });
    expect(rules(p4Violations(locked.request, locked.out))).toEqual(expect.arrayContaining(["P4_LOCKED_CHANGED", "P4_UPDATE_NOT_ALLOWED"]));
    // 交易字段被改
    const qtyChanged = clone(p4);
    Object.assign(decision(qtyChanged, "quantity"), { decision: "UPDATE", result_value: "999" });
    expect(rules(p4Violations(qtyChanged.request, qtyChanged.out))).toContain("P4_TRANSACTION_CHANGED");
    // 依据的范围不完整却写值
    const partial = clone(p4);
    partial.request.input.target_rows[0].fields.origin.evidence[0].scope.coverage = "PARTIAL";
    Object.assign(decision(partial, "origin"), { decision: "UPDATE", result_value: "中国", evidence_keys: [fields.origin.evidence[0].evidence_key] });
    expect(rules(p4Violations(partial.request, partial.out))).toContain("P4_INCOMPLETE_SCOPE_WRITE");
  });

  it("P2：真实录制输出没有违反；逐条改坏后各自被抓到；只发了图片的文件不判入仓号伪造", async () => {
    const { p2Violations } = await import("@/lib/experiments/business-rules");
    const p2 = load("v3/SC-08/P2");
    expect(p2Violations(p2.request, p2.out)).toEqual([]);
    const o = (x: any) => x.out.output;
    const check = (mutate: (x: any) => void) => {
      const x = clone(p2);
      mutate(x);
      return rules(p2Violations(x.request, x.out));
    };
    // 入仓号：原文里没有 / 不是 8 位；候选号码只要求原文里有
    expect(check((x) => (o(x).logical_inspections[0].warehouse_no = "12345678"))).toContain("P2_FAKE_WAREHOUSE_NO");
    expect(check((x) => (o(x).raw_rows[0].warehouse_no = "2512033"))).toContain("P2_FAKE_WAREHOUSE_NO");
    expect(check((x) => (o(x).raw_rows[0].candidate_warehouse_nos = ["2512100302"]))).not.toContain("P2_FAKE_WAREHOUSE_NO");
    // 只发了图片的文件：号码可能在图里，不判伪造
    expect(
      check((x) => {
        o(x).logical_inspections[0].warehouse_no = "12345678";
        x.request.input.files.push({ file_id: "F-img", segments: ["page:1"], content: null });
        o(x).read_status.push({ file_id: "F-img", read_segments: ["page:1"], unread_segments: [], status: "COMPLETE" });
      }),
    ).not.toContain("P2_FAKE_WAREHOUSE_NO");
    // 重复建单、行的入仓号没有逻辑单
    expect(check((x) => o(x).logical_inspections.push(clone(o(x).logical_inspections[0])))).toContain("P2_DUPLICATE_LOGICAL");
    expect(check((x) => (o(x).logical_inspections = []))).toContain("P2_ORPHAN_WAREHOUSE");
    // 行号重复、包装范围引用不存在的行
    expect(check((x) => (o(x).raw_rows[1].record_no = 1))).toContain("P2_RECORD_NO_DUP");
    expect(check((x) => o(x).scope_records[0].member_record_nos.push(99))).toContain("P2_UNKNOWN_MEMBER");
    // 同一记录复制到另一个入仓号
    expect(
      check((x) => {
        const copy = clone(o(x).raw_rows[0]);
        copy.record_no = 3;
        copy.warehouse_no = "2512100302".slice(0, 8);
        o(x).raw_rows.push(copy);
      }),
    ).toContain("P2_ROW_COPIED");
    // 整单共享净重被复制到每一行
    expect(
      check((x) => {
        const total = o(x).scope_records[0].measurements.find((m: any) => m.field === "net_weight").value;
        o(x).raw_rows.forEach((r: any) => (r.fields.net_weight = total));
      }),
    ).toContain("P2_SHARED_VALUE_COPIED");
    // 有没读的页却说读完了
    expect(check((x) => x.request.input.files[0].segments.push("page:2"))).toContain("P2_READ_CLAIMED_COMPLETE");
    expect(check((x) => (o(x).read_status[0].status = "INCOMPLETE"))).toContain("P2_READ_CLAIMED_COMPLETE");
  });

  it("试运行：P4 修改后把数量这个交易字段改了 → 判为变差，结论建议拒绝", async () => {
    const f = getFixture("v3/SC-08/P4")!;
    const out = JSON.parse(f.raw);
    Object.assign(out.output.row_patches[0].field_decisions.find((d: any) => d.field === "quantity"), { decision: "UPDATE", result_value: "999" });
    const candRaw = JSON.stringify(out);
    setProviderForTests(
      new OpenAICompatibleProvider(
        { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-m3", timeoutMs: 2000 },
        (async (_u: string, init?: RequestInit) => {
          const system = (JSON.parse(String(init?.body)).messages as { content: string }[])[0].content;
          return Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: system.includes(FIX_LINE) ? candRaw : f.raw }, finish_reason: "stop" }], usage: { total_tokens: 3 } });
        }) as unknown as typeof fetch,
      ),
    );
    const base = listVersions("jiuli-p4")[0];
    const c = createCandidate({ promptId: "jiuli-p4", baseVersionId: base.version_id, system: base.system_prompt + FIX_LINE, userTemplate: base.user_prompt_template, reason: "r", createdBy: "t" }).candidate;
    const exp = await startExperiment({ candidateId: c.candidate_id, samples: [{ sample_id: "v3/SC-08/P4", role: "TARGET" }, { sample_id: "v3/SC-08-audit/P4", role: "REGRESSION" }], maxModelRuns: 4, createdBy: "t" }).done;
    const s0 = exp.report!.samples[0];
    // 一次改动同时违反三条：交易字段不能改、数量不允许 UPDATE、写值却没引用任何输入证据
    expect(s0.business_rules).toMatchObject({ baseline: 0, candidate: 3 });
    expect(s0.hard_gates).toEqual(expect.arrayContaining([expect.stringMatching(/交易字段.*quantity/), expect.stringMatching(/UPDATE/), expect.stringMatching(/没有引用任何输入证据/)]));
    expect(s0.verdict).toBe("REGRESSED");
    expect(exp.report!.conclusion).toBe("NOT_RECOMMENDED");
  });
});
