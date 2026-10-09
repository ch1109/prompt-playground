// AT01~AT28 中可在服务端/纯函数层验证的部分。界面联动类用例见 e2e/acceptance.spec.ts。
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { JiuliDemoFilesConnector } from "@/lib/connectors/jiuli-demo-files";
import { JiuliHttpPlaceholderConnector } from "@/lib/connectors/registry";
import { buildJiuliSnapshot } from "@/lib/connectors/snapshot-builder";
import { ConnectorError } from "@/lib/connectors/types";
import type { ViewModel } from "@/lib/contracts/view-model";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { validateRendererConfig } from "@/lib/renderer-config/registry";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { addAnnotation, getRun, saveRun } from "@/lib/repositories/runs";
import { createSnapshot, getSnapshot } from "@/lib/repositories/snapshots";
import { modelRun, renderOnly, rerender, RunServiceError } from "@/lib/runs/service";
import { P1_VALUE_KEYS } from "@/lib/schemas/common";

const DEMO_ROOT = "/Users/chch/Desktop/九立demo";
const hasDemo = (() => {
  try {
    return statSync(join(DEMO_ROOT, "demo-generated", "mock")).isDirectory();
  } catch {
    return false;
  }
})();

function fx(id: string) {
  const f = getFixture(id);
  if (!f) throw new Error(`fixture ${id} 不存在`);
  return f;
}
function render(id: string, extra: Partial<Parameters<typeof runPipeline>[0]["context"]> = {}) {
  const f = fx(id);
  return runPipeline({ raw: f.raw, promptKind: f.promptKind, context: { runId: "t", request: f.request, gold: f.gold, baseDraft: f.baseDraft, ...extra } });
}
const table = (vm: ViewModel | undefined, id: string) => vm!.tables.find((t) => t.id === id)!;

beforeAll(() => resetDbForTests(":memory:"));

describe("AT01 P1 v2.0 25 字段", () => {
  it("按真实 25 键渲染，无缺列/误映射，指针精确", () => {
    const r = render("v2/p1-original-output-example.json");
    expect(r.status).toBe("SUCCEEDED");
    const t = table(r.viewModel, "orderRows");
    expect(t.columns.map((c) => c.key)).toEqual(["row_seq", ...P1_VALUE_KEYS]);
    const row = t.rows[0];
    expect(row.id).toBe("ROW_TMP_001");
    for (const k of P1_VALUE_KEYS) expect(row.cells[k].jsonPointer).toBe(`/output/rows/0/values/${k}`);
  });
  it("v3.0 录制样本同样保留 25 列", () => {
    const t = table(render("v3/SC-08/P1").viewModel, "orderRows");
    expect(t.columns.slice(1).map((c) => c.key)).toEqual([...P1_VALUE_KEYS]);
    const f = fx("v3/SC-08/P1");
    const parsed = JSON.parse(f.raw);
    for (const k of P1_VALUE_KEYS) expect(t.rows[0].cells[k].value).toBe(parsed.output.rows[0].values[k]);
  });
});

describe("AT02 P1 多行与字段冲突", () => {
  it("冲突定位到正确行/字段，并带原文引用", () => {
    const vm = render("constructed/p1-v3-conflict.json").viewModel!;
    const issue = vm.issues.find((i) => i.type === "FIELD_CONFLICT")!;
    expect(issue.target).toMatchObject({ tableId: "orderRows", rowId: "row-1", fieldKey: "customs_unit_price" });
    const raws = issue.sourceRefIds.map((id) => vm.evidence.find((e) => e.id === id)?.rawText);
    expect(raws).toContain("USD 11.00");
    expect(raws).toContain("10");
    // 定位不依赖序号：行 ID 来自 row_no
    expect(table(vm, "orderRows").rows.map((r) => r.id)).toEqual(["row-1", "row-2", "row-3"]);
  });
});

describe("AT03 无牌 / 空白 / 0", () => {
  it("各保持原语义，不统一转 null", () => {
    const rows = table(render("constructed/p1-v3-conflict.json").viewModel, "orderRows").rows;
    expect(rows[1].cells.brand).toMatchObject({ value: "无牌", state: "EXPLICIT_NONE" });
    expect(rows[2].cells.brand).toMatchObject({ value: "", state: "NOT_DETECTED" });
    expect(rows[1].cells.quantity).toMatchObject({ value: "0", state: "PRESENT" });
  });
});

describe("AT04 漏行", () => {
  it("无 Gold 时不凭空告警", () => {
    const vm = render("constructed/p1-v3-conflict.json", { gold: undefined }).viewModel!;
    expect(vm.issues.some((i) => i.type === "ROW_COUNT_MISMATCH_GOLD")).toBe(false);
  });
  it("有独立 Gold 时才标漏行（来源为 RULE）", () => {
    const vm = render("constructed/p1-v3-conflict.json").viewModel!;
    expect(vm.issues.find((i) => i.type === "ROW_COUNT_MISMATCH_GOLD")).toMatchObject({ origin: "RULE" });
  });
});

describe("AT05 P2 同仓号多原始行", () => {
  it("v2：合并产品可展开到全部组成行，不丢行", () => {
    const vm = render("constructed/p2-v2-merge.json").viewModel!;
    const mp = table(vm, "mergedProducts").rows.find((r) => r.id === "MP_001")!;
    expect(mp.meta?.members).toEqual(["IR_001", "IR_002", "IR_003"]);
    const raw = table(vm, "inspectionRawRows").rows.map((r) => r.id);
    expect(raw).toEqual(expect.arrayContaining(["IR_001", "IR_002", "IR_003", "IR_009"]));
    // 悬空引用被诊断，不被静默丢弃
    expect(vm.diagnostics.some((d) => d.code === "RAW_ROW_REF_NOT_FOUND")).toBe(true);
  });
  it("v3：同一入仓号跨页的原始行都在该分组", () => {
    const raw = table(render("constructed/p2-v3-no-warehouse.json").viewModel, "inspectionRawRows").rows;
    expect(raw.filter((r) => r.meta?.group === "26091801").map((r) => r.cells.record_no.value)).toEqual([1, 2]);
  });
});

describe("AT06 P2 未识别仓号", () => {
  it("展示 unresolved，不制造假仓号", () => {
    const vm = render("constructed/p2-v3-no-warehouse.json").viewModel!;
    const li = table(vm, "logicalInspections").rows.map((r) => r.cells.warehouse_no.value);
    expect(li).toEqual(["26091801"]);
    const rec3 = table(vm, "inspectionRawRows").rows.find((r) => r.cells.record_no.value === 3)!;
    expect(rec3.meta?.group).toBe("__UNRESOLVED__");
    expect(rec3.cells.warehouse_no.value).toBe("");
    expect(vm.issues.some((i) => i.type === "WAREHOUSE_UNRESOLVED")).toBe(true);
    const v2 = render("constructed/p2-v2-merge.json").viewModel!;
    expect(v2.issues.some((i) => i.type === "UNRESOLVED_SCOPE")).toBe(true);
    expect(table(v2, "logicalInspections").rows.find((r) => r.id === "LI_TMP_002")!.cells.warehouse_no.value).toBe("");
  });
});

describe("AT07 P2 多来源产地", () => {
  it("保留原始类别、文本与定位，不裁决最终值", () => {
    const vm = render("constructed/p2-v3-no-warehouse.json").viewModel!;
    const t = table(vm, "inspectionRawRows");
    expect(t.columns.some((c) => c.key === "origin")).toBe(false);
    const cell = t.rows[0].cells.origin_candidates;
    expect(cell.value).toBe("PRINTED_COD:MALAYSIA；HANDWRITTEN_COD:中国");
    expect(cell.sourceRefIds.map((id) => vm.evidence.find((e) => e.id === id)!.rawText)).toEqual(["COD: MALAYSIA", "手写 COD 中国"]);
  });
});

describe("AT08~AT10 P3", () => {
  const vm = () => render("constructed/p3-v3-multi-candidate.json").viewModel!;
  it("AT08 MATCHED 一对多：全部 raw_row_ids 与证据准确连线", () => {
    const rel = vm().relations.find((r) => r.fromId === "OR_001" && r.kind === "SELECTED")!;
    expect(rel.toIds).toEqual(["IR_A1", "IR_B1"]);
    expect(rel.sourceRefIds).toEqual(["E-O-1-MODEL", "E-I-A1-MODEL", "E-I-B1-MODEL"]);
    const ev = vm().evidence.find((e) => e.id === "E-I-B1-MODEL")!;
    expect(ev).toMatchObject({ fileId: "F-INSP-B", location: "REQUEST" });
  });
  it("AT09 多候选：完整展示，按模型原顺序，不自动挑第一个", () => {
    const v = vm();
    const rels = v.relations.filter((r) => r.fromId === "OR_002");
    expect(rels.map((r) => r.kind)).toEqual(["CANDIDATE", "CANDIDATE", "CANDIDATE"]);
    expect(rels.map((r) => r.toIds[0])).toEqual(["IR_C2", "IR_C1", "IR_C3"]);
    expect(table(v, "candidateGroups").rows.filter((r) => r.meta?.orderRowId === "OR_002" && r.meta?.kind === "SELECTED")).toHaveLength(0);
    expect(v.diagnostics.some((d) => d.code === "EVIDENCE_KEY_NOT_FOUND")).toBe(true);
  });
  it("AT10 UNMATCHED 且无池状态：只显示未匹配，不断言查货未到", () => {
    const v = vm();
    expect(table(v, "orderRows").rows.find((r) => r.id === "OR_003")!.cells.match_status.value).toBe("UNMATCHED");
    expect(v.relations.some((r) => r.fromId === "OR_003")).toBe(false);
    const text = JSON.stringify(v.issues) + JSON.stringify(v.tables);
    expect(text).not.toMatch(/查货(尚)?未到/);
  });
});

describe("AT11 P3 v2.1 待审门控", () => {
  it("关系状态与人工复核状态分列展示", () => {
    const r = render("constructed/p3-v2-review-status.json");
    const t = table(r.viewModel, "orderRows");
    const row = t.rows.find((x) => x.id === "OR_001")!;
    expect(row.cells.match_status.value).toBe("MATCHED");
    expect(row.cells.relation_review_status.value).toBe("PENDING_REVIEW");
    expect(t.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["match_status", "relation_review_status", "difference_flags", "unmatched_reason"]));
    expect(r.diagnostics.some((d) => d.code === "OPTIONAL_ENHANCEMENT_FIELD")).toBe(true);
  });
});

describe("AT12~AT15 P4", () => {
  const vm = () => render("constructed/p4-v3-conflict.json").viewModel!;
  it("AT12 KEEP+NO_EVIDENCE 显示未取得证据，不标已验证一致", () => {
    const v = vm();
    const ch = v.changes.find((c) => c.id === "OR_001:brand")!;
    expect(ch.verificationStatus).toBe("NO_EVIDENCE");
    expect(v.issues.find((i) => i.type === "NO_EVIDENCE")!.summary).toContain("未取得证据");
  });
  it("AT13 UPDATE / FILL 显示原值、候选值、来源（v2 还有规则）", () => {
    const v = vm();
    const up = v.changes.find((c) => c.id === "OR_001:origin")!;
    expect(up).toMatchObject({ action: "UPDATE", before: "中国", after: "马来西亚" });
    expect(v.evidence.find((e) => e.id === up.sourceRefIds[0])!.rawText).toBe("马来西亚");
    expect(v.changes.find((c) => c.id === "OR_001:net_weight")).toMatchObject({ action: "FILL", before: "", after: "1.2" });
    const v2 = render("constructed/p4-v2-with-base-draft.json").viewModel!;
    expect(v2.changes[0]).toMatchObject({ ruleId: "ORIGIN_PRIORITY_COMPLETE_COVERAGE", before: "中国", after: "马来西亚" });
  });
  it("AT14 CONFLICT/MISSING/锁定/阻断问题 不进入可自动模拟应用集合", () => {
    const v = vm();
    const sim = Object.fromEntries(v.changes.map((c) => [c.id, c.simulation!.applicable]));
    expect(sim).toEqual({
      "OR_001:brand": false,
      "OR_001:origin": true,
      "OR_001:net_weight": true,
      "OR_001:gross_weight": false,
      "OR_001:product_name": false,
      "OR_002:origin": false,
      "OR_002:net_weight": false,
    });
    expect(v.changes.find((c) => c.id === "OR_002:origin")!.simulation!.reason).toContain("LOCKED");
    expect(v.changes.find((c) => c.id === "OR_002:net_weight")!.simulation!.reason).toContain("blocks_auto_write");
  });
  it("AT15 无完整基准草稿：不生成 Patch 后整行草稿", () => {
    const v = vm();
    expect(v.tables.some((t) => t.id === "simulatedDraft")).toBe(false);
    expect(v.metadata!.notes!.join()).toContain("AT15");
    // 有版本匹配的完整基准时才生成，且只应用可模拟字段
    const v2 = render("constructed/p4-v2-with-base-draft.json").viewModel!;
    const row = table(v2, "simulatedDraft").rows[0];
    expect(row.cells.origin.value).toBe("马来西亚");
    expect(row.cells.net_weight.value).toBe("1.0");
    // 版本不匹配 → 不生成
    const v3 = render("constructed/p4-v2-with-base-draft.json", { baseDraft: { version: 2, rows: {} } }).viewModel!;
    expect(v3.tables.some((t) => t.id === "simulatedDraft")).toBe(false);
    expect(v3.diagnostics.some((d) => d.code === "BASE_DRAFT_VERSION_MISMATCH")).toBe(true);
  });
});

describe("AT16 / AT17 解析与 Schema 降级", () => {
  it("AT16 JSON 解析失败：保留原文与错误位置，无虚构表格", () => {
    const r = render("constructed/invalid-json-truncated.txt");
    expect(r.status).toBe("PARSE_ERROR");
    expect(r.viewModel).toBeUndefined();
    expect(r.parse.errorPosition?.line).toBeGreaterThan(0);
    const prose = render("constructed/not-pure-json.txt");
    expect(prose.status).toBe("PARSE_ERROR");
    expect(prose.diagnostics[0].code).toBe("NOT_PURE_JSON");
  });
  it("围栏 JSON 只在整段为单一代码块时显式提取并留痕", () => {
    const raw = "```json\n" + fx("constructed/p4-v3-conflict.json").raw + "```";
    const r = runPipeline({ raw, promptKind: "JIULI_P4", context: { runId: "t" } });
    expect(r.parse.extraction).toBe("FENCED");
    expect(r.diagnostics.some((d) => d.code === "FENCED_JSON_EXTRACTED")).toBe(true);
  });
  it("AT17 JSON 合法但 Schema 不匹配：SCHEMA_INVALID + 具体路径 + 局部渲染", () => {
    const r = render("constructed/p1-v3-schema-type-error.json");
    expect(r.status).toBe("SCHEMA_INVALID");
    const ptrs = r.validation.errors.map((e) => e.jsonPointer);
    expect(ptrs).toEqual(expect.arrayContaining(["/output/rows/0/values/quantity", "/output/rows/0/row_no", "/output/rows/0/conflicts", "/output/issues", "/output/processing_status"]));
    expect(r.validation.errors.find((e) => e.jsonPointer === "/output/rows/0/values/quantity")).toMatchObject({ expected: "类型 string", actual: "integer" });
    expect(r.partial).toBe(true);
    expect(table(r.viewModel, "orderRows").rows[0].cells.quantity.value).toBe(100);
  });
  it("未登记 Schema → UNKNOWN_SCHEMA，不套用九立模板", () => {
    const r = render("constructed/unknown-schema-version.json");
    expect(r.validation.status).toBe("UNKNOWN_SCHEMA");
    expect(r.viewModel).toBeUndefined();
  });
  it("9.1 未知枚举：标 Schema 错误但安全渲染", () => {
    const r = render("constructed/p3-v3-unknown-enum.json");
    expect(r.status).toBe("SCHEMA_INVALID");
    expect(table(r.viewModel, "orderRows").rows[0].cells.match_status.value).toBe("PROBABLY_MATCHED");
  });
});

describe("全部样本：渲染不修改输入 JSON，所有单元格指针真实存在", () => {
  const ids = ["v2/p1-original-output-example.json", "v2/p2-original-output-example.json", "v2/p3-original-output-example.json", "v2/p4-original-output-example.json", "v3/SC-08/P1", "v3/SC-08/P2", "v3/SC-08/P3", "v3/SC-08/P4", "v3/26SHPYD056-audit/P3", "constructed/p1-v3-conflict.json", "constructed/p4-v3-conflict.json"];
  for (const id of ids) {
    it(id, () => {
      const f = fx(id);
      const before = f.raw;
      const r = render(id);
      expect(f.raw).toBe(before);
      const parsed = JSON.parse(f.raw);
      for (const t of r.viewModel!.tables) {
        for (const row of t.rows) {
          for (const c of Object.values(row.cells)) {
            if (!c.jsonPointer || c.jsonPointer.startsWith("req:")) continue;
            expect(getByPointer(parsed, c.jsonPointer).found, `${t.id}/${row.id}/${c.fieldKey} → ${c.jsonPointer}`).toBe(true);
          }
        }
      }
    });
  }
});

describe("AT19 原文无权限 / 失效", () => {
  it("证据按快照授权显示 FORBIDDEN / METADATA_ONLY，不越权", () => {
    const vm = render("constructed/p3-v3-multi-candidate.json", { materials: { "F-INSP-A": { availability: "FORBIDDEN" }, "F-INSP-B": { availability: "AVAILABLE" }, "F-ORDER": { availability: "MISSING" } } }).viewModel!;
    expect(vm.evidence.find((e) => e.id === "E-I-A1-MODEL")!.availability).toBe("FORBIDDEN");
    expect(vm.evidence.find((e) => e.id === "E-I-B1-MODEL")!.availability).toBe("AVAILABLE");
    expect(vm.evidence.find((e) => e.id === "E-O-1-MODEL")!.availability).toBe("METADATA_ONLY");
    expect(vm.evidence.find((e) => e.id === "E-NOT-EXIST")!.availability).toBe("MISSING");
  });
  it.skipIf(!hasDemo)("未授权客户的文件预览被服务端拒绝", async () => {
    const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "C-89aa660b4b46" });
    await expect(c.getPreview("F-3c3cc10bd26b")).resolves.toMatchObject({ mediaType: expect.stringContaining("spreadsheet") });
    const other = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "C-NOBODY" });
    await expect(other.getPreview("F-3c3cc10bd26b")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(other.getPreview("../../etc/passwd")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("AT20 只读连接不可用", () => {
  it("凭据/路径错误 → CONNECTOR_UNAVAILABLE；离线样本仍可工作", async () => {
    const bad = new JiuliDemoFilesConnector({ root: "/nonexistent/jiuli", allowedCustomers: "*" });
    expect((await bad.capabilities()).status).toBe("CONNECTOR_UNAVAILABLE");
    await expect(bad.searchCustomers("", 1)).rejects.toMatchObject({ code: "CONNECTOR_UNAVAILABLE" });
    expect((await new JiuliHttpPlaceholderConnector("https://example.invalid").capabilities()).status).toBe("CONNECTOR_UNAVAILABLE");
    expect((await new JiuliHttpPlaceholderConnector().capabilities()).status).toBe("NOT_CONFIGURED");
    expect(render("constructed/p1-v3-conflict.json").status).toBe("SUCCEEDED");
  });
});

describe.skipIf(!hasDemo)("AT21 跨客户选择任务", () => {
  const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "C-89aa660b4b46" });
  it("服务端拒绝，不依赖前端隐藏", async () => {
    const customers = await c.searchCustomers("", 1);
    expect(customers.items.map((x) => x.customer_id)).toEqual(["C-89aa660b4b46"]);
    const all = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/entrustment-drafts.json"), "utf8")) as { id: string; customerId: string }[];
    const foreign = all.find((d) => d.customerId !== "C-89aa660b4b46")!;
    await expect(c.getTaskFacts(foreign.id)).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.listOrderTasks(foreign.customerId, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const orders = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/inspection-orders.json"), "utf8")) as { id: string; customerId: string }[];
    const foreignBatch = orders.find((o) => o.customerId !== "C-89aa660b4b46")!;
    await expect(c.getInspectionFacts("C-89aa660b4b46", [foreignBatch.id])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("创建快照时任务与客户不匹配、客户未授权 → FORBIDDEN（API 返回 403，而不是 500）", async () => {
    const all = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/entrustment-drafts.json"), "utf8")) as { id: string; customerId: string }[];
    const foreign = all.find((d) => d.customerId !== "C-89aa660b4b46")!;
    const open = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "*" });
    await expect(buildJiuliSnapshot(open, { projectId: "jiuli", customerId: "C-89aa660b4b46", taskId: foreign.id, batchIds: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(buildJiuliSnapshot(c, { projectId: "jiuli", customerId: foreign.customerId, batchIds: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

function fakeFetch(impl: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_url: string, init?: RequestInit) => impl(init)) as unknown as typeof fetch;
}
const cfg = { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-secret-123456", timeoutMs: 80 };

describe("AT22 模型断流 / 超时 / 失败", () => {
  const snap = () => snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
  const cases: [string, (init?: RequestInit) => Promise<Response>, string][] = [
    ["HTTP 500", async () => new Response("upstream error sk-test-secret-123456", { status: 500 }), "MODEL_HTTP_500"],
    ["网络错误", async () => Promise.reject(new TypeError("fetch failed")), "MODEL_NETWORK_ERROR"],
    ["超时", (init) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))), "MODEL_TIMEOUT"],
    ["断流（包装被截断）", async () => new Response('{"choices":[{"message":{"content":"{\\"sche', { status: 200 }), "MODEL_BAD_ENVELOPE"],
  ];
  for (const [name, impl, code] of cases) {
    it(`${name} → 保存失败 Run，不显示 Mock 成功`, async () => {
      setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(impl)));
      const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
      expect(run.status).toBe("MODEL_ERROR");
      expect(run.error?.code).toBe(code);
      expect(run.view_model).toBeNull();
      expect(getRun(run.run_id)!.status).toBe("MODEL_ERROR");
      expect(JSON.stringify(getRun(run.run_id))).not.toContain("sk-test-secret-123456");
    });
  }
  it("成功响应才进入解析流水线（真实调用以外的路径用假服务验证，不代表真实模型已运行）", async () => {
    const body = fx("v3/SC-08/P1").raw;
    setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(async () => Response.json({ choices: [{ message: { content: body } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: { temperature: 0 } });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.is_unsaved_draft).toBe(true);
    expect(run.actual_prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.token_usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    setProviderForTests(undefined);
  });
});

describe.skipIf(!hasDemo)("附带原件图片（视觉模型）", () => {
  const send = async (fixtureId: string, attachImages: boolean) => {
    let sent: { messages: { content: unknown }[] } | undefined;
    const f = fx(fixtureId);
    setProviderForTests(
      new OpenAICompatibleProvider(
        cfg,
        fakeFetch(async (init) => {
          sent = JSON.parse(String(init?.body));
          return Response.json({ choices: [{ message: { content: f.raw } }] });
        }),
      ),
    );
    const run = await modelRun({ projectId: "jiuli", promptId: `jiuli-p${f.promptKind.slice(-1)}`, snapshotId: snapshotForFixture("jiuli", f)!.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {}, attachImages });
    setProviderForTests(undefined);
    return { run, user: sent!.messages[1].content };
  };
  beforeAll(() => {
    process.env.JIULI_DEMO_ROOT = DEMO_ROOT;
    process.env.JIULI_ALLOWED_CUSTOMERS = "*";
  });

  it("PDF 原件逐页转图随请求发送，Run 只记录元数据，原件不变", async () => {
    const pdf = join(DEMO_ROOT, "真实整单样本/2025YBT010-2/查货文件/1765426942103.pdf");
    const before = createHash("sha256").update(readFileSync(pdf)).digest("hex");
    const { run, user } = await send("v3/SC-08/P2", true);
    const parts = user as { type: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe("text");
    expect(parts.length).toBe(2);
    expect(parts[1].image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(run.attached_images).toEqual([expect.objectContaining({ file_id: "F-8bc7177252aa", page: 1, media_type: "image/jpeg" })]);
    expect(JSON.stringify(getRun(run.run_id))).not.toContain("base64,");
    expect(createHash("sha256").update(readFileSync(pdf)).digest("hex")).toBe(before);
  });

  it("Excel 原件不转图并记警告；未开启时只发文字", async () => {
    const { run } = await send("v3/SC-08/P1", true);
    expect(run.attached_images).toEqual([]);
    expect((run as { input_builder_warnings?: string[] }).input_builder_warnings!.join()).toContain("不是 PDF 或图片");
    const off = await send("v3/SC-08/P2", false);
    expect(typeof off.user).toBe("string");
    expect(off.run.attached_images).toBeNull();
  });
});

describe("AT24 同快照回放 / 标注不污染原文", () => {
  it("原始输入/输出 Hash 不变，标注独立保存", () => {
    const f = fx("v3/SC-08/P3");
    const snap = snapshotForFixture("jiuli", f)!;
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p3", raw: f.raw, snapshotId: snap.snapshot_id });
    addAnnotation({ run_id: run.run_id, target_json_pointer: "/output/row_relations/0/match_status", target: "x", issue_type: "MODEL_WRONG", expected_value: "UNMATCHED", note: "测试" });
    const again = getRun(run.run_id)!;
    expect(again.raw_response).toBe(f.raw);
    expect(again.raw_response_hash).toBe(createHash("sha256").update(f.raw).digest("hex"));
    expect(JSON.stringify(again.parsed_json)).toBe(JSON.stringify(JSON.parse(f.raw)));
    const replay = rerender(run.run_id);
    expect(replay.raw_response_hash).toBe(run.raw_response_hash);
    expect(replay.input_snapshot_id).toBe(snap.snapshot_id);
    expect(getSnapshot(snap.snapshot_id)!.content_hash).toBe(snap.content_hash);
    expect(() => db().prepare("UPDATE raw_responses SET raw = 'x' WHERE run_id = ?").run(run.run_id)).toThrow(/不可修改/);
  });
});

describe("AT25 只读安全", () => {
  const WRITE = /^(post|put|patch|delete|remove|create|update|write|save|insert|upsert|set|apply|commit|occupy|verify)/i;
  it("Connector 接口与实现上不存在任何写方法", () => {
    for (const cls of [JiuliDemoFilesConnector, JiuliHttpPlaceholderConnector]) {
      const names = [...Object.getOwnPropertyNames(cls.prototype), ...Object.keys(new (cls as unknown as new (o: unknown) => object)({ root: "/x", allowedCustomers: "" }))];
      expect(names.filter((n) => WRITE.test(n))).toEqual([]);
    }
    const iface = readFileSync("lib/connectors/types.ts", "utf8");
    const methods = [...iface.matchAll(/^\s+(\w+)\??\(/gm)].map((m) => m[1]);
    expect(methods.filter((n) => WRITE.test(n))).toEqual([]);
  });
  it("代码中没有任何对九立源的写请求或写文件路径", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) && files.push(join(d, n))));
    ["lib", "app", "components"].forEach(walk);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // 唯一的外部 HTTP 写调用只允许是模型网关
      if (/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(src) && !f.endsWith("openai-compatible.ts") && !f.startsWith("lib/client") && !f.startsWith("components")) throw new Error(`${f} 含写请求`);
      // 唯一允许的写文件：上传原件存入 Studio 私有目录 data/materials（路径只经 materialsDir/uploadedPath 生成）
      if (f === join("lib", "materials", "store.ts") || f === join("lib", "repositories", "snapshots.ts")) {
        expect(/materialsDir\(|uploadedPath\(/.test(src), `${f} 写文件必须限定在 Studio 私有目录`).toBe(true);
        continue;
      }
      expect(/writeFileSync|appendFileSync|createWriteStream|unlinkSync|rmSync|renameSync/.test(src), `${f} 写文件`).toBe(false);
    }
    const connectorSrc = readdirSync("lib/connectors").map((n) => readFileSync(join("lib/connectors", n), "utf8")).join("\n");
    expect(connectorSrc).not.toMatch(/fetch\(/);
    expect(connectorSrc).not.toMatch(/JIULI_API_TOKEN/);
  });
  it.skipIf(!hasDemo)("执行导入后九立 Demo 数据文件内容不变", async () => {
    const dir = join(DEMO_ROOT, "demo-generated/mock");
    const digest = () => readdirSync(dir).map((n) => n + createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")).join();
    const before = digest();
    const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "*" });
    const tasks = await c.listOrderTasks("C-89aa660b4b46", 1);
    const batches = await c.listInspectionBatches("C-89aa660b4b46", 1);
    await buildJiuliSnapshot(c, { projectId: "jiuli", customerId: "C-89aa660b4b46", taskId: tasks.items[0].task_id, batchIds: batches.items.map((b) => b.batch_id) });
    expect(digest()).toBe(before);
  });
});

describe.skipIf(!hasDemo)("AT26 刷新创建新快照", () => {
  it("不更改正在使用的旧快照", async () => {
    const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "*" });
    const sel = { projectId: "jiuli", customerId: "C-89aa660b4b46", taskId: "D-3c3cc10bd26b", batchIds: ["I-8bc7177252aa-25120336"] };
    const s1 = await buildJiuliSnapshot(c, sel);
    const body1 = JSON.stringify(getSnapshot(s1.snapshot_id));
    const s2 = await buildJiuliSnapshot(c, { ...sel, parentSnapshotId: s1.snapshot_id });
    expect(s2.snapshot_id).not.toBe(s1.snapshot_id);
    expect(s2.parent_snapshot_id).toBe(s1.snapshot_id);
    expect(JSON.stringify(getSnapshot(s1.snapshot_id))).toBe(body1);
    // 快照携带了 P3 可构造输入与 P4 模拟所需的完整基准草稿
    expect((s1.normalized_payload.baseDraft as { rows: object }).rows).toHaveProperty("D-3c3cc10bd26b-R007");
  });
});

describe("AT27 模型不支持文件格式", () => {
  it("明确阻断，不默默只发文件名；模型未被调用", async () => {
    let called = false;
    setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(async () => ((called = true), Response.json({})))));
    const snap = createSnapshot({
      project_id: "jiuli",
      source_type: "JIULI_READONLY",
      label: "无预处理文本",
      data_contract_version: "test",
      materials: [{ material_id: "m1", file_id: "F-000000000001", has_text_content: false, availability: "AVAILABLE" }],
      normalized_payload: { customer: { customer_id: "C1", name: "客户" }, task: { fileId: "F-000000000001", customerId: "C1" }, lines: [], inspections: { batches: [], sourceLines: [], groups: [] }, extracted: {} },
    });
    await expect(modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} })).rejects.toMatchObject({ code: "FILE_INPUT_UNSUPPORTED" });
    expect(called).toBe(false);
    setProviderForTests(undefined);
  });
  it("未配置模型时拒绝运行，不回退 Mock", async () => {
    setProviderForTests(new OpenAICompatibleProvider({ baseUrl: "", model: "", apiKey: "" }));
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    await expect(modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} })).rejects.toBeInstanceOf(RunServiceError);
    setProviderForTests(undefined);
  });
});

describe("AT28 代码版本升级重渲染历史 Run", () => {
  it("不改历史原始结果，标明 Adapter 版本变化", () => {
    const f = fx("constructed/p1-v3-conflict.json");
    // 模拟"历史 Run 由旧版 Adapter 生成"（已结束的 Run 不可 UPDATE，直接写入一条旧版本记录）
    const current = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: f.raw });
    const run = saveRun({ ...current, run_id: "run_old_adapter", adapter_version: "0.9.0" });
    const re = rerender(run.run_id);
    expect(re.mode).toBe("REPLAY");
    expect(re.replay_of_run_id).toBe(run.run_id);
    expect(re.rerender_note).toContain("jiuli-p1-v3@0.9.0 → jiuli-p1-v3@1.0.0");
    expect(re.raw_response_hash).toBe(run.raw_response_hash);
    expect(getRun(run.run_id)!.adapter_version).toBe("0.9.0");
  });
});

describe("渲染配置白名单", () => {
  it("非白名单组件、任意表达式绑定、可执行代码一律拒绝", () => {
    const base = { renderer_id: "x", renderer_config_version: "1.0.0", adapter_id: "a", layout: "wide-table-with-issues" };
    expect(validateRendererConfig({ ...base, regions: [{ id: "a", component: "data-table", binding: "tables.orderRows" }] }).ok).toBe(true);
    expect(validateRendererConfig({ ...base, regions: [{ id: "a", component: "iframe", binding: "issues" }] }).ok).toBe(false);
    expect(validateRendererConfig({ ...base, regions: [{ id: "a", component: "data-table", binding: "tables[0].rows.map(x=>x)" }] }).ok).toBe(false);
    expect(validateRendererConfig({ ...base, regions: [{ id: "a", component: "data-table", binding: "issues", options: { fmt: "(x) => alert(1)" } }] }).ok).toBe(false);
  });
});

describe("预览与运行使用同一份输入", () => {
  it("按当前输入模式决定快照，不沿用其他模式留下的快照", async () => {
    const { emptyWorkspace, runSnapshotId } = await import("@/lib/state/studio-store");
    const ws = { ...emptyWorkspace(), snapshotId: "snap_jiuli", fixtureId: "v3/x/P1", fixtureSnapshotId: "snap_fixture", uploadSnapshotId: "snap_upload" };
    expect(runSnapshotId({ ...ws, inputMode: "fixture" })).toBe("snap_fixture");
    expect(runSnapshotId({ ...ws, inputMode: "fixture", fixtureSnapshotId: null })).toBeNull();
    expect(runSnapshotId({ ...ws, inputMode: "snapshot" })).toBe("snap_jiuli");
    expect(runSnapshotId({ ...ws, inputMode: "paste" })).toBeNull();
    expect(runSnapshotId({ ...ws, inputMode: "jiuli" })).toBeNull();
    expect(runSnapshotId({ ...ws, inputMode: "upload" })).toBe("snap_upload");
    expect(runSnapshotId({ ...ws, inputMode: "upload", uploadSnapshotId: null })).toBeNull();
  });
});

describe("运行中状态与截断诊断", () => {
  const snap = () => snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
  const okBody = (content: string, finish_reason = "stop") => Response.json({ choices: [{ message: { content }, finish_reason }] });

  it("调用期间可见 RUNNING，结束后变为终态；运行中不能重渲染", async () => {
    let release!: (r: Response) => void;
    setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(() => new Promise<Response>((r) => (release = r)))));
    const pending = modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    await new Promise((r) => setTimeout(r, 20));
    const { listRuns } = await import("@/lib/repositories/runs");
    const running = listRuns("jiuli").find((r) => r.status === "RUNNING");
    expect(running).toBeDefined();
    expect(getRun(running!.run_id)!.raw_response).toBe("");
    expect(() => rerender(running!.run_id)).toThrow(RunServiceError);
    release(okBody(fx("v3/SC-08/P1").raw));
    const done = await pending;
    setProviderForTests(undefined);
    expect(done.run_id).toBe(running!.run_id);
    expect(done.status).toBe("SUCCEEDED");
    expect(getRun(done.run_id)!.status).toBe("SUCCEEDED");
    expect(getRun(done.run_id)!.raw_response_hash).toBe(createHash("sha256").update(fx("v3/SC-08/P1").raw).digest("hex"));
  });

  it("开始运行立即返回 Run ID（不等模型）：刷新页面后可凭 ID 继续等待结果", async () => {
    let release!: (r: Response) => void;
    setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(() => new Promise<Response>((r) => (release = r)))));
    const { startModelRun } = await import("@/lib/runs/service");
    const { runId, done } = startModelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(getRun(runId)!.status).toBe("RUNNING");
    await new Promise((r) => setTimeout(r, 20));
    release(okBody(fx("v3/SC-08/P1").raw));
    expect((await done).status).toBe("SUCCEEDED");
    setProviderForTests(undefined);
    expect(getRun(runId)!.status).toBe("SUCCEEDED");
  });

  it("开始前就能发现的问题（如未配置模型）直接报错，不留下 RUNNING 记录", async () => {
    const { startModelRun } = await import("@/lib/runs/service");
    const { listRuns } = await import("@/lib/repositories/runs");
    const before = listRuns("jiuli").length;
    setProviderForTests(new OpenAICompatibleProvider({ baseUrl: "", model: "", apiKey: "" }));
    expect(() => startModelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} })).toThrow(RunServiceError);
    setProviderForTests(undefined);
    expect(listRuns("jiuli").length).toBe(before);
  });

  it("finish_reason=length → 记录结束原因并给出截断诊断", async () => {
    setProviderForTests(new OpenAICompatibleProvider(cfg, fakeFetch(async () => okBody('{"schema_version":"jiuli-ai-v3","out', "length"))));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}", params: { max_tokens: 10 } });
    setProviderForTests(undefined);
    expect(run.status).toBe("PARSE_ERROR");
    expect(run.finish_reason).toBe("length");
    expect(run.parse_diagnostics.map((d) => d.code)).toContain("MODEL_OUTPUT_TRUNCATED");
  });

  it("已结束的 Run 在数据库层面不可修改", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    expect(() => db().prepare("UPDATE runs SET status = 'MODEL_ERROR' WHERE run_id = ?").run(run.run_id)).toThrow();
  });

  it("服务重启时遗留的 RUNNING 标记为中断（MODEL_ERROR / INTERRUPTED）", async () => {
    const { startRun, markInterruptedRuns } = await import("@/lib/repositories/runs");
    const base = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: "{}" });
    const id = "run_interrupted_test";
    startRun({ ...base, run_id: id, mode: "MODEL_RUN", status: "RUNNING", raw_response: "", raw_response_hash: "" });
    markInterruptedRuns();
    const r = getRun(id)!;
    expect(r.status).toBe("MODEL_ERROR");
    expect(r.error?.code).toBe("INTERRUPTED");
  });
});

describe("运行对比：提示词差异与关键指标", () => {
  it("找出改动的提示词行，并列出状态/Token/Schema 错误数", async () => {
    const { compareRuns } = await import("@/components/playground/run-compare");
    const base = renderOnly({ projectId: "jiuli", promptId: "jiuli-p2", raw: "{}" });
    const sys = ["第一行", "read_status 每项为 {...}", "第三行"].join("\n");
    const a = { ...base, mode: "MODEL_RUN" as const, status: "SCHEMA_INVALID" as const, actual_prompt: { system: sys, user: "U" }, token_usage: { prompt_tokens: 3005, completion_tokens: 10564 }, built_input_hash: "h1",
      schema_diagnostics: [{ phase: "SCHEMA" as const, level: "ERROR" as const, code: "SCHEMA_TYPE", message: "x", jsonPointer: "/output/read_status" }] };
    const b = { ...a, status: "SUCCEEDED" as const, actual_prompt: { system: sys.replace("read_status 每项为", "read_status 必须是数组，每项为"), user: "U" }, token_usage: { prompt_tokens: 3015, completion_tokens: 13840 }, schema_diagnostics: [] };
    const c = compareRuns(a, b);
    expect(c.system!.flatMap((h) => h.lines)).toEqual(expect.arrayContaining(["-read_status 每项为 {...}", "+read_status 必须是数组，每项为 {...}"]));
    expect(c.user).toEqual([]);
    const row = (k: string) => c.metrics.find((m) => m.key === k)!;
    expect(row("状态")).toMatchObject({ a: "SCHEMA_INVALID", b: "SUCCEEDED", differs: true });
    expect(row("Schema 错误数")).toMatchObject({ a: "1", b: "0" });
    expect(row("构造输入 Hash")).toMatchObject({ differs: false });
    // 仅渲染的 Run 没有提示词：明确为 null，而不是"无差异"
    expect(compareRuns(base, b).system).toBeNull();
  });
});

describe("标注导出", () => {
  it("导出行带 Run 信息与模型原值；CSV 含 BOM 并正确转义", async () => {
    const { exportAnnotations, annotationsToCsv } = await import("@/lib/repositories/annotations-export");
    const f = fx("constructed/p1-v3-conflict.json");
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: f.raw, label: "导出测试" });
    addAnnotation({ run_id: run.run_id, target_json_pointer: "/output/rows/0/values/model", target: "orderRows / row-1 / model", issue_type: "CORRECT_VALUE", expected_value: 'ABC-02 "正确"', note: "第一行\n第二行" });
    const rows = exportAnnotations("jiuli").filter((r) => r.run_id === run.run_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_label: "导出测试", prompt_kind: "JIULI_P1", issue_type: "CORRECT_VALUE", model_value: "ABC-01", expected_value: 'ABC-02 "正确"' });
    const csv = annotationsToCsv(rows);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"ABC-02 ""正确"""');
    expect(csv).toContain('"第一行\n第二行"');
  });
});

describe("快照适用的 Prompt 种类", () => {
  it("样本快照只适用于自身阶段；九立快照按可构造的阶段判断（P4 不适用）", async () => {
    const { usableKinds } = await import("@/lib/input-builders");
    expect(usableKinds(snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!)).toEqual(["JIULI_P1", "GENERIC_JSON"]);
    if (!hasDemo) return;
    const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "*" });
    const task = (await c.listOrderTasks("C-132ffbd28c07", 1)).items[0];
    const batches = (await c.listInspectionBatches("C-132ffbd28c07", 1)).items.map((b) => b.batch_id);
    const snap = await buildJiuliSnapshot(c, { projectId: "jiuli", customerId: "C-132ffbd28c07", taskId: task.task_id, batchIds: batches });
    expect(usableKinds(snap)).toEqual(["JIULI_P1", "JIULI_P2", "JIULI_P3", "GENERIC_JSON"]);
  });
});

describe("提示词源文件更新检测", () => {
  it("文件内容变化时追加新版本（记录 parent），不覆盖旧版本；内容不变不重复追加", async () => {
    const { listVersions, syncSeedVersion } = await import("@/lib/repositories/prompts");
    const source = "prompts/jiuli-v3/P2_inspection_facts_FINAL_v3.0.txt";
    const before = listVersions("jiuli-p2");
    const seed = before.find((v) => v.source === source)!;
    const changed = seed.system_prompt + "\n新增规则：read_status 必须是数组。";
    const v = syncSeedVersion("jiuli-p2", source, changed)!;
    expect(v.parent_version_id).toBe(seed.version_id);
    expect(v.label).toContain("文件已更新");
    expect(syncSeedVersion("jiuli-p2", source, changed)).toBeNull();
    const after = listVersions("jiuli-p2");
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((x) => x.version_id === seed.version_id)!.system_prompt).toBe(seed.system_prompt);
  });
});

describe.skipIf(!hasDemo)("九立导入 P1 带辅助材料", () => {
  it("按 documentSegments 拆为 INVOICE / PACKING_LIST，内容只含对应页；无法判断类型的才警告", async () => {
    const { buildInput, INPUT_BUILDER_VERSION } = await import("@/lib/input-builders");
    const c = new JiuliDemoFilesConnector({ root: DEMO_ROOT, allowedCustomers: "*" });
    const drafts = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/entrustment-drafts.json"), "utf8")) as { id: string; customerId: string }[];
    const task = drafts.find((d) => d.id === "D-1df4f4d83480")!;
    const snap = await buildJiuliSnapshot(c, { projectId: "jiuli", customerId: task.customerId, taskId: task.id, batchIds: [] });
    const built = buildInput("JIULI_P1", snap);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const mats = (built.request.input as { materials: { file_id: string; material_type: string; segments: string[]; content: { pages?: { page: number }[] } | null }[] }).materials;
    expect(mats[0].material_type).toBe("ORDER");
    const inv = mats.find((m) => m.file_id === "F-80d89610605b" && m.material_type === "INVOICE")!;
    const pl = mats.find((m) => m.file_id === "F-80d89610605b" && m.material_type === "PACKING_LIST")!;
    expect(inv.segments).toEqual(["page:1"]);
    expect(pl.segments).toEqual(["page:2", "page:3"]);
    expect(inv.content!.pages!.map((p) => p.page)).toEqual([1]);
    expect(pl.content!.pages!.map((p) => p.page)).toEqual([2, 3]);
    expect(built.warnings.join()).not.toContain("未标明");
    expect(INPUT_BUILDER_VERSION).toBe("1.2.0");
  });
});

describe("证据按页跳转", () => {
  it("有页码时预览链接带 #page=N，无页码时不带", async () => {
    const { previewHref } = await import("@/components/renderers/evidence-viewer");
    expect(previewHref({ fileId: "F-80d89610605b", page: 3 })).toBe("/api/materials/F-80d89610605b/preview#page=3");
    expect(previewHref({ fileId: "F-80d89610605b", page: null })).toBe("/api/materials/F-80d89610605b/preview");
  });
});

describe("快照删除与到期", () => {
  const mk = () =>
    createSnapshot({ project_id: "jiuli", source_type: "JSON_IMPORT", label: "删除测试", data_contract_version: "x", normalized_payload: { request_kind: "JIULI_P1", request: { a: 1 } },
      materials: [{ material_id: `mat_${Math.random()}`, file_id: "F-000000000001", file_name: "a.pdf", has_text_content: false, availability: "METADATA_ONLY" }] });

  it("删除只移除快照内容与材料记录；历史 Run 与原始输出不变，可看到删除时间；不能再用于重渲染", async () => {
    const { deleteSnapshot, listSnapshots, snapshotDeletedAt } = await import("@/lib/repositories/snapshots");
    const s = mk();
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw, snapshotId: s.snapshot_id });
    deleteSnapshot(s.snapshot_id);
    expect(getSnapshot(s.snapshot_id)).toBeUndefined();
    expect(listSnapshots("jiuli").some((x) => x.snapshot_id === s.snapshot_id)).toBe(false);
    expect(db().prepare("SELECT count(*) c FROM input_materials WHERE snapshot_id = ?").get(s.snapshot_id)).toMatchObject({ c: 0 });
    expect(snapshotDeletedAt(s.snapshot_id)).toMatch(/^\d{4}-/);
    expect(getRun(run.run_id)!.raw_response_hash).toBe(run.raw_response_hash);
    expect(() => rerender(run.run_id)).toThrow(/已删除/);
  });

  it("到期的快照在清理时删除，未到期与未设置到期的保留", async () => {
    const { purgeExpiredSnapshots, setSnapshotExpiry } = await import("@/lib/repositories/snapshots");
    const expired = mk();
    const later = mk();
    const never = mk();
    setSnapshotExpiry(expired.snapshot_id, new Date(Date.now() - 1000).toISOString());
    setSnapshotExpiry(later.snapshot_id, new Date(Date.now() + 86400000).toISOString());
    expect(purgeExpiredSnapshots()).toContain(expired.snapshot_id);
    expect(getSnapshot(expired.snapshot_id)).toBeUndefined();
    expect(getSnapshot(later.snapshot_id)).toBeDefined();
    expect(getSnapshot(never.snapshot_id)).toBeDefined();
  });

  it("样本快照被删除后，再次选择样本会新建快照而不是复用已删除的", async () => {
    const { deleteSnapshot } = await import("@/lib/repositories/snapshots");
    const a = snapshotForFixture("jiuli", fx("v3/SC-08/P2"))!;
    deleteSnapshot(a.snapshot_id);
    const b = snapshotForFixture("jiuli", fx("v3/SC-08/P2"))!;
    expect(b.snapshot_id).not.toBe(a.snapshot_id);
    expect(getSnapshot(b.snapshot_id)).toBeDefined();
  });
});

describe("多项目", () => {
  it("按九立模板新建：复制 P1~P4 当前最新版本为初始版本 + 通用 JSON；空白模板只有通用 JSON；数据按项目隔离", async () => {
    const { createProject, listPrompts, listVersions, listProjects } = await import("@/lib/repositories/prompts");
    const { listRuns } = await import("@/lib/repositories/runs");
    const p = createProject({ name: "  评测项目  ", template: "JIULI" });
    expect(p.name).toBe("评测项目");
    const prompts = listPrompts(p.project_id);
    expect(prompts.map((x) => x.prompt_kind).sort()).toEqual(["GENERIC_JSON", "JIULI_P1", "JIULI_P2", "JIULI_P3", "JIULI_P4"]);
    const p2 = prompts.find((x) => x.prompt_kind === "JIULI_P2")!;
    const [copied] = listVersions(p2.prompt_id);
    expect(copied.system_prompt).toBe(listVersions("jiuli-p2")[0].system_prompt);
    expect(copied.source).toBe(`copy:${listVersions("jiuli-p2")[0].version_id}`);
    const blank = createProject({ name: "空白", template: "BLANK" });
    expect(listPrompts(blank.project_id).map((x) => x.prompt_kind)).toEqual(["GENERIC_JSON"]);
    expect(listProjects().map((x) => (x as { project_id: string }).project_id)).toEqual(expect.arrayContaining(["jiuli", p.project_id, blank.project_id]));
    renderOnly({ projectId: p.project_id, promptId: p2.prompt_id, raw: fx("v3/SC-08/P2").raw });
    expect(listRuns(p.project_id)).toHaveLength(1);
    expect(listRuns("jiuli").some((r) => r.prompt_id === p2.prompt_id)).toBe(false);
    expect(() => createProject({ name: " ", template: "BLANK" })).toThrow();
  });
});

describe("文件导入（PDF / Excel / 图片）", () => {
  // 按文件 ID 查九立 Demo 文件清单里的路径（文件名含特殊空格，不手写）
  const demo = (fileId: string) => {
    const files = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/source-files.json"), "utf8")) as { id: string; path: string }[];
    return readFileSync(join(DEMO_ROOT, files.find((f) => f.id === fileId)!.path));
  };
  const xlsxBuf = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["型号", "数量"], ["ABC-01", 10]]), "委托");
    return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  };

  it("Excel 按 Sheet 抽为单元格；文件类型与内容不符时拒绝", async () => {
    const { preprocessFile } = await import("@/lib/materials/preprocess");
    const r = await preprocessFile(await xlsxBuf(), "委托.xlsx");
    expect(r.has_text).toBe(true);
    expect(r.content).toMatchObject({ sheets: [{ name: "委托", cells: expect.arrayContaining([{ row: 2, column: 1, value: "ABC-01" }]) }] });
    expect(r.segments).toEqual(["sheet:委托"]);
    expect(r.preprocessor_version).toMatch(/sheetjs@0\.20\.3/);
    await expect(preprocessFile(Buffer.from("not a pdf"), "x.pdf")).rejects.toThrow(/内容与扩展名不符/);
    await expect(preprocessFile(Buffer.from("x"), "x.exe")).rejects.toThrow(/不支持/);
  });

  it.skipIf(!hasDemo)("文字型 PDF 按页抽文字；扫描件无文字层时如实标记并提示改用原件图片", async () => {
    const { preprocessFile } = await import("@/lib/materials/preprocess");
    const text = await preprocessFile(demo("F-0971c3fd7c49"), "a.pdf");
    expect(text.has_text).toBe(true);
    expect((text.content as { pages: { page: number; text: string }[] }).pages[0]).toMatchObject({ page: 1, text: expect.stringContaining("委托方") });
    expect(text.segments).toEqual(["page:1"]);
    expect(text.preprocessor_version).toMatch(/pdftotext/);
    const scanned = await preprocessFile(demo("F-1f89bab4fe64"), "b.pdf");
    expect(scanned.has_text).toBe(false);
    expect(scanned.warnings.join()).toMatch(/没有文字层/);
  });

  it("上传建快照：P1/P2 输入按材料类型构造，原件 Hash 与预处理版本留痕；删除快照后无人引用的原件被移除", async () => {
    const { createFileSnapshot, resolveUploadedFile } = await import("@/lib/materials/store");
    const { buildInput, usableKinds } = await import("@/lib/input-builders");
    const { deleteSnapshot } = await import("@/lib/repositories/snapshots");
    const { existsSync } = await import("node:fs");
    process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-test-mat-"));
    const buf = await xlsxBuf();
    const snap = await createFileSnapshot({
      projectId: "jiuli",
      label: "上传测试",
      customerName: "测试客户",
      files: [
        { name: "委托.xlsx", buffer: buf, materialType: "ORDER" },
        { name: "查货.xlsx", buffer: buf, materialType: "INSPECTION" },
      ],
    });
    expect(snap.source_type).toBe("FILE_IMPORT");
    expect(snap.materials[0]).toMatchObject({ file_name: "委托.xlsx", content_hash: createHash("sha256").update(buf).digest("hex"), availability: "AVAILABLE", has_text_content: true });
    expect(usableKinds(snap)).toEqual(["JIULI_P1", "JIULI_P2", "GENERIC_JSON"]);
    const p1 = buildInput("JIULI_P1", snap);
    expect(p1.ok && p1.builderId).toBe("file-import-p1");
    if (!p1.ok) return;
    const m = (p1.request.input as { materials: { file_id: string; material_type: string; segments: string[] }[] }).materials;
    expect(m).toEqual([expect.objectContaining({ material_type: "ORDER", segments: ["sheet:委托"] })]);
    expect((p1.request.context as { customer_directory: { customer_name: string }[] }).customer_directory[0].customer_name).toBe("测试客户");
    const p2 = buildInput("JIULI_P2", snap);
    expect(p2.ok && (p2.request.input as { files: unknown[] }).files).toHaveLength(1);
    const path = resolveUploadedFile(m[0].file_id)!.absolutePath;
    expect(existsSync(path)).toBe(true);
    deleteSnapshot(snap.snapshot_id);
    expect(resolveUploadedFile(m[0].file_id)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});

describe.skipIf(!hasDemo)("扫描件上传后用视觉模型运行", () => {
  it("没有文字层的 PDF：不附带图片时阻断；附带原件图片时允许运行并发送页面图片", async () => {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-test-mat-"));
    const files = JSON.parse(readFileSync(join(DEMO_ROOT, "demo-generated/mock/source-files.json"), "utf8")) as { id: string; path: string }[];
    const scanned = readFileSync(join(DEMO_ROOT, files.find((f) => f.id === "F-1f89bab4fe64")!.path));
    const snap = await createFileSnapshot({ projectId: "jiuli", files: [{ name: "扫描委托书.pdf", buffer: scanned, materialType: "ORDER" }] });
    let sentImages = 0;
    setProviderForTests(
      new OpenAICompatibleProvider(
        cfg,
        fakeFetch(async (init) => {
          const content = JSON.parse(String(init?.body)).messages[1].content;
          sentImages = Array.isArray(content) ? content.filter((p: { type: string }) => p.type === "image_url").length : 0;
          return Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
        }),
      ),
    );
    const base = { projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} };
    await expect(modelRun({ ...base, attachImages: false })).rejects.toMatchObject({ code: "FILE_INPUT_UNSUPPORTED" });
    const run = await modelRun({ ...base, attachImages: true });
    setProviderForTests(undefined);
    expect(run.status).not.toBe("MODEL_ERROR");
    expect(sentImages).toBe(1);
    expect(run.attached_images).toHaveLength(1);
  });
});
