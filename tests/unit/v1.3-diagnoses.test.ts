// v1.3 §8：Agent 诊断报告落库（结构校验、证据引用核对、只追加、不改人工标注、MCP 授权与审计）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import type { Run } from "@/lib/contracts/run";
import { submitDiagnosis } from "@/lib/diagnoses/report";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createGrant, listAudit, READ_SCOPES, type Scope } from "@/lib/repositories/agent-access";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { listDiagnoses } from "@/lib/repositories/diagnoses";
import { addAnnotation, listAnnotations } from "@/lib/repositories/runs";
import { loadRunContext } from "@/lib/runs/debug-bundle";
import { modelRun } from "@/lib/runs/service";

let run: Run;
/** 一个有来源的格子：行、字段、JSON 位置与来源 ID */
let cell: { table_id: string; row_id: string; field: string; json_pointer: string; source_ref: string };
let annotationId: string;

beforeAll(async () => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-diag-mat-"));
  const f = getFixture("v3/SC-08/P1")!;
  const snap = snapshotForFixture("jiuli", f)!;
  setProviderForTests(
    new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-diag-abcdef", timeoutMs: 2000 }, (async () =>
      Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: f.raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch),
  );
  run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "第一行\n第二行\n第三行", userTemplate: "{{input_json}}", params: { temperature: 0 } });
  setProviderForTests(undefined);
  const t = run.view_model!.tables.find((x) => x.rows.some((r) => Object.values(r.cells).some((c) => c.sourceRefIds?.length)))!;
  const r = t.rows.find((x) => Object.values(x.cells).some((c) => c.sourceRefIds?.length))!;
  const [field, c] = Object.entries(r.cells).find(([, c]) => c.sourceRefIds?.length)!;
  cell = { table_id: t.id, row_id: r.id, field, json_pointer: c.jsonPointer, source_ref: c.sourceRefIds![0] };
  annotationId = addAnnotation({ run_id: run.run_id, target_json_pointer: cell.json_pointer, target: null, issue_type: "ASSESSMENT", expected_value: "人工期望值", note: null, assessment: "WRONG", error_category: "UNKNOWN", category_confirmed: null, model_value: null, source_ref_ids: [], author: "我" }).annotation_id;
});

const report = (over: Record<string, unknown> = {}, rootCause: Record<string, unknown> = {}) => ({
  observed_problem: "模型值与人工期望不一致",
  verified_facts: ["原件这一格写的是 X"],
  root_cause: { category: "PROMPT_RULE_ERROR", summary: "规则没写清优先级", supporting_evidence_refs: [`${run.run_id}#${cell.source_ref}`], ...rootCause },
  limitations: [],
  proposed_change: { target_layer: "PROMPT", action_type: "EDIT_PROMPT_RULE", summary: "补一句优先级" },
  impact_scope: "所有 P1 产地",
  verification_plan: "目标样本 + 两个回归样本",
  result_status: "CONFIRMED",
  ...over,
});

const ctx = () => loadRunContext(run.run_id)!;
const loadRun = (id: string) => {
  const c = loadRunContext(id);
  if (!c) throw new Error(`Run ${id} 不存在`);
  return c;
};
const submit = (r: unknown, objectRef: Record<string, string> | undefined = { row_id: cell.row_id, field: cell.field }) => submitDiagnosis({ ctx: ctx(), objectRef, report: r, createdBy: "test-agent", loadRun });

describe("诊断报告校验", () => {
  it("合法报告保存为一条只追加记录；五种引用格式都能核对通过", () => {
    const refs = [`${run.run_id}#${cell.source_ref}`, `${run.run_id}#${cell.json_pointer}`, `${run.run_id}#trace/raw_response`, `${run.run_id}#prompt/system:L2-L3`, `${run.run_id}#annotation/${annotationId}@1`];
    const d = submit(report({}, { supporting_evidence_refs: refs }));
    expect(d).toMatchObject({ run_id: run.run_id, root_cause_category: "PROMPT_RULE_ERROR", result_status: "CONFIRMED", created_by: "test-agent", target: { stage: "P1", row_id: cell.row_id, field: cell.field, json_pointer: cell.json_pointer } });
    expect(listDiagnoses(run.run_id).map((x) => x.diagnosis_id)).toContain(d.diagnosis_id);
    expect(() => db().prepare("UPDATE diagnoses SET result_status = 'UNKNOWN'").run()).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM diagnoses").run()).toThrow(/只追加/);
  });

  it("缺字段、取值不合法都整份拒绝", () => {
    const n = listDiagnoses(run.run_id).length;
    expect(() => submit({ ...report(), verified_facts: [] })).toThrow(/缺字段或取值不合法/);
    expect(() => submit(report({}, { category: "MODEL_GUESS" }))).toThrow(/缺字段或取值不合法/);
    expect(listDiagnoses(run.run_id)).toHaveLength(n);
  });

  it("CONFIRMED 必须有支持证据，且归因不能是 UNKNOWN / EVIDENCE_INSUFFICIENT；证据不足可以不给引用", () => {
    expect(() => submit(report({}, { supporting_evidence_refs: [] }))).toThrow(/至少要有一条支持证据/);
    expect(() => submit(report({}, { category: "UNKNOWN" }))).toThrow(/不能是 CONFIRMED/);
    expect(submit(report({ result_status: "NEEDS_MORE_EVIDENCE" }, { category: "EVIDENCE_INSUFFICIENT", supporting_evidence_refs: [] })).result_status).toBe("NEEDS_MORE_EVIDENCE");
  });

  it("编造的引用（不存在的来源、行号越界、别人的标注、不存在的 Run）整份拒绝，并列出哪几条不对", () => {
    const n = listDiagnoses(run.run_id).length;
    const fake = [`${run.run_id}#src-made-up`, `${run.run_id}#prompt/system:L99`, `${run.run_id}#annotation/ann_nope`, `${run.run_id}#trace/everything`, "没有井号"];
    try {
      submit(report({}, { counter_evidence_refs: fake }));
      throw new Error("应该被拒绝");
    } catch (e) {
      expect((e as { details: { invalid_refs: { ref: string }[] } }).details.invalid_refs.map((x) => x.ref)).toEqual(fake);
    }
    expect(() => submit(report({}, { supporting_evidence_refs: ["run_doesnotexist#trace/raw_response"] }))).toThrow(/不存在/);
    expect(listDiagnoses(run.run_id)).toHaveLength(n);
  });

  it("诊断不改人工标注", () => {
    const before = JSON.stringify(listAnnotations(run.run_id));
    submit(report({}, { category: "OCR_VISION_ERROR" }));
    expect(JSON.stringify(listAnnotations(run.run_id))).toBe(before);
  });
});

describe("诊断报告 MCP 工具", () => {
  const tok = (o: { projectIds?: string[]; scopes?: Scope[] } = {}) => createGrant({ principal: "agent-diag", projectIds: o.projectIds ?? ["jiuli"], scopes: o.scopes }).token;
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
    return { isError: !!j.result.isError, text, data: text.startsWith("{") ? JSON.parse(text) : null };
  };

  it("默认令牌可以提交，记审计；get_diagnoses 能按字段读回", async () => {
    const t = tok();
    const r = await call(t, "submit_diagnosis_report", { run_id: run.run_id, object_ref: { row_id: cell.row_id, field: cell.field }, report: report() });
    expect(r.isError).toBe(false);
    expect(listAudit(1)[0]).toMatchObject({ tool: "submit_diagnosis_report", outcome: "ALLOWED", run_id: run.run_id });
    const got = await call(t, "get_diagnoses", { run_id: run.run_id, object_ref: { row_id: cell.row_id, field: cell.field } });
    expect(got.data.diagnoses.map((d: { diagnosis_id: string }) => d.diagnosis_id)).toContain(r.data.diagnosis_id);
    expect(got.data.diagnoses.every((d: { target: { json_pointer: string } }) => d.target.json_pointer === cell.json_pointer)).toBe(true);
  });

  it("只读令牌没有提交工具；越权项目被拒并审计", async () => {
    expect(await call(tok({ scopes: [...READ_SCOPES] }), "submit_diagnosis_report", { run_id: run.run_id, report: report() })).toMatchObject({ isError: true, text: expect.stringMatching(/not found/i) });
    const n = listDiagnoses(run.run_id).length;
    const other = await call(tok({ projectIds: ["other-project"] }), "submit_diagnosis_report", { run_id: run.run_id, report: report() });
    expect(other).toMatchObject({ isError: true, data: { error: { code: "FORBIDDEN" } } });
    expect(listAudit(1)[0]).toMatchObject({ tool: "submit_diagnosis_report", outcome: "DENIED" });
    expect(listDiagnoses(run.run_id)).toHaveLength(n);
  });

  it("引用对不上时返回 BAD_REQUEST 与具体原因，不保存", async () => {
    const n = listDiagnoses(run.run_id).length;
    const r = await call(tok(), "submit_diagnosis_report", { run_id: run.run_id, report: report({}, { supporting_evidence_refs: [`${run.run_id}#src-made-up`] }) });
    expect(r).toMatchObject({ isError: true, data: { error: { code: "BAD_REQUEST", details: { invalid_refs: [{ ref: `${run.run_id}#src-made-up` }] } } } });
    expect(listDiagnoses(run.run_id)).toHaveLength(n);
  });
});
