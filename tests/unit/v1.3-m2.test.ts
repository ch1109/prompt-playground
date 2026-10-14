// v1.3 M2：Run Debug Bundle + 只读 MCP（授权、审计、证据读取、缺证据坦白）。真实 Agent 客户端的验收见 docs/audit/v1.3-gap-matrix.md。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { POST } from "@/app/api/mcp/route";
import type { Run } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { newId } from "@/lib/hash";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createGrant, listAudit, READ_SCOPES, revokeGrant, verifyToken, type Scope } from "@/lib/repositories/agent-access";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { addAnnotation, getRun, saveRun, startRun } from "@/lib/repositories/runs";
import { modelRun, renderOnly } from "@/lib/runs/service";

const API_KEY = "sk-test-secret-m2-abcdef";
let run: Run;
let otherRun: Run;

function fx(id: string) {
  const f = getFixture(id);
  if (!f) throw new Error(`fixture ${id} 不存在`);
  return f;
}

function fakeProvider(raw: string) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: API_KEY, timeoutMs: 2000 },
    (async () => Response.json({ id: "chatcmpl-m2", model: "fake-model", choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch,
  );
}

beforeAll(async () => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-m2-mat-"));
  const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
  setProviderForTests(fakeProvider(fx("v3/SC-08/P1").raw));
  run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: { temperature: 0 } });
  otherRun = renderOnly({ projectId: "jiuli", promptId: "jiuli-p2", raw: fx("v3/SC-08/P2").raw, snapshotId: snapshotForFixture("jiuli", fx("v3/SC-08/P2"))!.snapshot_id });
  setProviderForTests(undefined);
});
afterEach(() => setProviderForTests(undefined));

const token = (o: { projectIds?: string[]; customerIds?: string[]; scopes?: Scope[] } = {}) => createGrant({ principal: "test-agent", projectIds: o.projectIds ?? ["jiuli"], customerIds: o.customerIds, scopes: o.scopes }).token;

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request("http://localhost:3000/api/mcp", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) }));
}

/** 调用一个工具，返回解析后的结果与是否出错 */
async function call(tok: string, name: string, args: Record<string, unknown>) {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${tok}` });
  const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!j.result.isError, text: j.result.content[0].text, data: JSON.parse(j.result.content[0].text) };
}

describe("M2 访问授权与审计", () => {
  it("令牌只存 hash；撤销、过期后失效", () => {
    const { grant, token: t } = createGrant({ principal: "codex", projectIds: ["jiuli"] });
    expect(JSON.stringify(db().prepare("SELECT * FROM agent_access_grants").all())).not.toContain(t);
    expect(verifyToken(t)).toMatchObject({ ok: true, grant: { principal: "codex", scopes: ["runs:read", "prompts:read", "evidence:read", "annotations:read", "eval:read", "diagnoses:write"] } });
    revokeGrant(grant.grant_id);
    expect(verifyToken(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/撤销/) });
    const t2 = token();
    db().prepare("UPDATE agent_access_grants SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM agent_access_grants ORDER BY created_at DESC LIMIT 1)").run("2000-01-01T00:00:00.000Z");
    expect(verifyToken(t2)).toMatchObject({ ok: false, reason: expect.stringMatching(/过期/) });
  });

  it("默认只发只读权限 + 提交诊断报告；没有修改正式版本之类的权限可发（M3 起实验权限须显式加上）", () => {
    expect(createGrant({ principal: "x", projectIds: ["jiuli"] }).grant.scopes.filter((s) => !s.endsWith(":read"))).toEqual(["diagnoses:write"]);
    expect(() => createGrant({ principal: "x", projectIds: ["jiuli"], scopes: ["prompts:promote" as Scope] })).toThrow(/不支持的权限/);
  });

  it("没有令牌返回 401 并审计；非本机 Host 返回 403", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(listAudit(1)[0]).toMatchObject({ tool: "(auth)", outcome: "DENIED" });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "evil.example.com", authorization: `Bearer ${token()}` })).status).toBe(403);
  });

  it("AG-09 只读令牌只有 9 个只读工具；默认令牌只多一个「提交诊断报告」，没有其他写入入口", async () => {
    const list = async (tok: string) => {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${tok}` });
      return ((await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools;
    };
    const readOnly = await list(token({ scopes: [...READ_SCOPES] }));
    expect(readOnly.map((t) => t.name).sort()).toEqual(["compare_runs", "get_annotations", "get_diagnoses", "get_evaluation", "get_prompt_snapshot", "get_run_manifest", "get_run_trace", "get_source_evidence", "list_runs"]);
    expect(readOnly.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const tools = await list(token());
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(["submit_diagnosis_report"]);
    expect(tools).toHaveLength(10);
  });

  it("AG-08 越权项目 / 越权客户 / 缺权限范围：返回权限错误并审计", async () => {
    const other = await call(token({ projectIds: ["other-project"] }), "get_run_manifest", { run_id: run.run_id });
    expect(other).toMatchObject({ isError: true, data: { error: { code: "FORBIDDEN" } } });
    expect(listAudit(1)[0]).toMatchObject({ tool: "get_run_manifest", run_id: run.run_id, outcome: "DENIED" });
    expect((await call(token({ customerIds: ["C-someone-else"] }), "get_run_manifest", { run_id: run.run_id })).data.error.code).toBe("FORBIDDEN");
    expect((await call(token({ customerIds: ["C-89aa660b4b46"] }), "get_run_manifest", { run_id: run.run_id })).isError).toBe(false);
    expect((await call(token({ scopes: ["runs:read"] }), "get_source_evidence", { run_id: run.run_id, source_ref: "x" })).data.error.message).toMatch(/evidence:read/);
  });

  it("审计记录只能追加", async () => {
    await call(token(), "get_evaluation", { run_id: run.run_id });
    expect(listAudit(1)[0]).toMatchObject({ tool: "get_evaluation", outcome: "ALLOWED", principal: "test-agent" });
    expect(() => db().prepare("UPDATE agent_audit_log SET outcome = 'X'").run()).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM agent_audit_log").run()).toThrow(/只追加/);
  });
});

describe("M2 Debug Bundle 读取", () => {
  it("AG-01/02 manifest：版本、采集完整度、客户范围；所有工具输出不含密钥", async () => {
    const t = token();
    const m = await call(t, "get_run_manifest", { run_id: run.run_id });
    expect(m.data).toMatchObject({ bundle_version: "run-debug-bundle@1.0.0", prompt_stage: "P1", capture_quality: "COMPLETE", customer_scope: "C-89aa660b4b46", versions: { schema_version: "jiuli-ai-v3", input_manifest_version: "input-manifest@1.1.0" }, capabilities: { raw_request_captured: true } });
    expect(m.data.notice).toMatch(/不可信/);
    const all = [
      m.text,
      (await call(t, "get_run_trace", { run_id: run.run_id, parts: ["actual_request", "built_input", "preprocessing", "raw_response", "schema", "adapter", "provenance"] })).text,
      (await call(t, "get_prompt_snapshot", { run_id: run.run_id, include: ["system", "user", "user_template"] })).text,
    ].join("\n");
    expect(all).not.toContain(API_KEY);
  });

  it("AG-03 字段级：显示值、模型原始节点、来源，以及来源处实际输入的内容", async () => {
    const t = token();
    const tr = await call(t, "get_run_trace", { run_id: run.run_id, parts: ["preprocessing"], object_ref: { row_id: "row-1", field: "origin" } });
    expect(tr.data.object).toMatchObject({ resolved: { table_id: "orderRows", json_pointer: "/output/rows/0/values/origin" }, display_value: "韩国", adapter_converted: false, input_coverage: [{ status: "TEXT_SENT" }] });
    const ref = tr.data.object.evidence_refs[0];
    const ev = await call(t, "get_source_evidence", { run_id: run.run_id, source_ref: ref });
    expect(ev.data).toMatchObject({ input_origin: "RUN_BUILT_INPUT", claimed_by_model: { sheet: "12-10-2", row: 7, column: "F", raw_text: "韩国" }, input_at_location: { found: true, value_at_location: "韩国", raw_text_matches: true } });
  });

  it("对象找不到返回 NOT_FOUND 并列出可用行；source_ref 不是本 Run 登记的来源时拒绝", async () => {
    const t = token();
    const nf = await call(t, "get_run_trace", { run_id: run.run_id, object_ref: { row_id: "row-99", field: "origin" } });
    expect(nf.data.error.code).toBe("NOT_FOUND");
    expect(nf.data.error.details.tables).toEqual(expect.arrayContaining([expect.objectContaining({ table_id: "orderRows", row_ids: ["row-1", "row-2"] })]));
    // 来源 ID 只在本 Run 登记的来源里查找：编造的位置或文件路径都读不到
    for (const ref of ["/output/rows/99/evidence/0/source", "../../etc/passwd", "F-3c3cc10bd26b"]) expect((await call(t, "get_source_evidence", { run_id: run.run_id, source_ref: ref })).data.error.code).toBe("SOURCE_REF_NOT_IN_RUN");
  });

  it("AG-04 旧 Run 缺请求和预处理记录：逐项返回 available:false 与原因，不补造", async () => {
    const { request_actual: _a, built_input: _b, adapter_diagnostics: _c, response_meta: _d, ...rest } = run;
    const legacy = saveRun({ ...rest, run_id: newId("run"), input_manifest: null } as Run);
    const tr = await call(token(), "get_run_trace", { run_id: legacy.run_id, parts: ["actual_request", "built_input", "preprocessing", "adapter"] });
    expect(tr.data.capture_quality).toBe("PARTIAL");
    expect(tr.data.parts.actual_request).toMatchObject({ available: false });
    expect(tr.data.parts.preprocessing).toMatchObject({ available: false, reason: expect.stringMatching(/输入覆盖清单/) });
    expect(tr.data.parts.built_input).toMatchObject({ available: false, snapshot_request_available: true });
    expect(tr.data.limitations.length).toBe(4);
    // 读证据不会改动 Run
    expect(getRun(legacy.run_id)!.request_actual).toBeUndefined();
  });

  it("标注按对象过滤并带修订；评测没有 Gold 时如实返回未评测", async () => {
    addAnnotation({ run_id: run.run_id, target_json_pointer: "/output/rows/0/values/origin", target: null, issue_type: "ASSESSMENT", expected_value: "美国", note: null, assessment: "WRONG", error_category: "UNKNOWN" });
    const t = token();
    const a = await call(t, "get_annotations", { run_id: run.run_id, object_ref: { row_id: "row-1", field: "origin" } });
    expect(a.data).toMatchObject({ count: 1, annotations: [{ expected_value: "美国", revision: 1 }], gold: { available: false } });
    expect((await call(t, "get_annotations", { run_id: run.run_id, object_ref: { row_id: "row-1", field: "brand" } })).data.count).toBe(0);
    expect((await call(t, "get_evaluation", { run_id: run.run_id })).data).toMatchObject({ status: "EVAL_NOT_AVAILABLE", gold_version: null, human_annotation_counts: { wrong: 1 } });
  });

  it("提示词快照：按 Run 返回实际发送内容；按版本返回已保存内容；两者都给或都不给时报错", async () => {
    const t = token();
    expect((await call(t, "get_prompt_snapshot", { run_id: run.run_id })).data).toMatchObject({ source: "RUN_ACTUAL", available: true, parts: { system: { text: "S" } } });
    expect((await call(t, "get_prompt_snapshot", {})).data.error.code).toBe("BAD_REQUEST");
    const v = db().prepare("SELECT version_id FROM prompt_versions WHERE prompt_id = 'jiuli-p1' LIMIT 1").get() as { version_id: string };
    expect((await call(t, "get_prompt_snapshot", { prompt_version_id: v.version_id })).data).toMatchObject({ source: "SAVED_VERSION", prompt_id: "jiuli-p1" });
  });

  it("list_runs 分页与过滤；compare_runs 给出输入可比性", async () => {
    const t = token();
    const p1 = await call(t, "list_runs", { project_id: "jiuli", limit: 1 });
    expect(p1.data.items).toHaveLength(1);
    expect(p1.data.next_cursor).toBeTruthy();
    const p2 = await call(t, "list_runs", { project_id: "jiuli", limit: 1, cursor: p1.data.next_cursor });
    expect(p2.data.items[0].run_id).not.toBe(p1.data.items[0].run_id);
    const byStage = await call(t, "list_runs", { project_id: "jiuli", stage: "P2", sample_id: "v3/SC-08/P2" });
    expect(byStage.data.items.map((r: { run_id: string }) => r.run_id)).toEqual([otherRun.run_id]);
    const cmp = await call(t, "compare_runs", { base_run_id: otherRun.run_id, candidate_run_id: run.run_id });
    expect(cmp.data.input_comparability.comparable).toBe(false);
    expect(cmp.data.note).toMatch(/不可直接比较/);
  });
});

describe("原件核对（get_source_evidence view=original）", () => {
  /** 一个只有 Sheet「12-10-2」的委托 Excel：F7 = 产地，H7 = 带千分位格式的数量 */
  function orderXlsx(origin: string) {
    const ws = XLSX.utils.aoa_to_sheet([[], [], [], [], [], ["序号", "货物名称", "品牌", "型号", "参数", "产地", "单位", "数量"], [1, "晶圆", "SK HYNIX", "H25G9TCXXCX702A#9", "64GB", origin, "个", 12081]]);
    ws["H7"].z = "#,##0";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "12-10-2");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  /** 上传原件 → 用录制的 SC-08 P1 输出（file_id 换成上传原件）跑一次模型运行 */
  async function runOnUpload(buf: Buffer, claimedFileId?: string) {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const snap = await createFileSnapshot({ projectId: "jiuli", files: [{ name: "委托.xlsx", buffer: buf, materialType: "ORDER" }] });
    const fileId = snap.materials[0].file_id;
    setProviderForTests(fakeProvider(fx("v3/SC-08/P1").raw.replaceAll("F-3c3cc10bd26b", claimedFileId ?? fileId)));
    const r = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    return { r, fileId };
  }
  const ORIGIN_REF = "/output/rows/0/evidence/5/source";

  it("打开原件读出来源单元格，与构造输入、模型原文对照；原件 Hash 与记录一致", async () => {
    const { r, fileId } = await runOnUpload(orderXlsx("韩国"));
    const ev = await call(token(), "get_source_evidence", { run_id: r.run_id, source_ref: ORIGIN_REF, view: "original" });
    expect(ev.data.original).toMatchObject({
      file: { file_id: fileId, hash_matches_record: true },
      original_at_location: { found: true, sheet: "12-10-2", row: 7, column: "F", value_at_location: "韩国", raw_text_matches: true, row_values: { D: "H25G9TCXXCX702A#9", H: "12,081" } },
      comparison: { original_equals_input: true, original_matches_model_raw_text: true },
    });
  });

  it("模型声称的文件不在这次运行的输入里：不打开（即使那个文件本身有权限读）", async () => {
    const { fileId: elsewhere } = await runOnUpload(orderXlsx("美国"));
    const { r } = await runOnUpload(orderXlsx("韩国 "), elsewhere);
    const ev = await call(token(), "get_source_evidence", { run_id: r.run_id, source_ref: ORIGIN_REF, view: "original" });
    expect(ev.data.original).toEqual({ found: false, reason: expect.stringMatching(/不在这次运行的输入里/) });
  });

  it("运行后原件被替换：照常读出，但标明 Hash 与记录不一致", async () => {
    const { r, fileId } = await runOnUpload(orderXlsx("日本"));
    const { resolveUploadedFile } = await import("@/lib/materials/store");
    writeFileSync(resolveUploadedFile(fileId)!.absolutePath, orderXlsx("德国"));
    const ev = await call(token(), "get_source_evidence", { run_id: r.run_id, source_ref: ORIGIN_REF, view: "original" });
    expect(ev.data.original).toMatchObject({ file: { hash_matches_record: false }, original_at_location: { value_at_location: "德国" }, comparison: { original_equals_input: false } });
  });
});

describe("M2 命令行工具与网页服务同时打开数据库", () => {
  it("STUDIO_CLI=1 打开数据库时不把网页服务正在进行的 Run 标为中断", () => {
    const file = join(mkdtempSync(join(tmpdir(), "studio-m2-db-")), "s.db");
    resetDbForTests(file);
    startRun({ ...run, run_id: "run_live", status: "RUNNING" });
    process.env.STUDIO_CLI = "1";
    resetDbForTests(file);
    expect(getRun("run_live")!.status).toBe("RUNNING");
    delete process.env.STUDIO_CLI;
    resetDbForTests(file);
    expect(getRun("run_live")!.status).toBe("MODEL_ERROR");
  });
});
