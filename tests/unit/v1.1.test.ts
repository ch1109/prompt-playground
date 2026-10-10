// v1.1 验收（AT-01 ~ AT-36 中服务端 / 纯函数层可验证的部分）。界面用例见 e2e/v1.1.spec.ts。
// 所有模型调用都用本地假服务，不代表真实模型已运行。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { resetDbForTests } from "@/lib/repositories/db";
import { getRun } from "@/lib/repositories/runs";
import { modelRun, previewModelRun, retryRun } from "@/lib/runs/service";

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-v11-mat-"));
});

function fx(id: string) {
  const f = getFixture(id);
  if (!f) throw new Error(`fixture ${id} 不存在`);
  return f;
}

function fakeFetch(impl: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_url: string, init?: RequestInit) => impl(init)) as unknown as typeof fetch;
}
const baseCfg = { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-secret-123456", timeoutMs: 2000 };
const caps = (over: Partial<ReturnType<typeof defaultCaps>> = {}) => ({ ...defaultCaps(), ...over });
function defaultCaps() {
  return { images: true as boolean | null, nativePdf: false as const, jsonMode: null as boolean | null, thinking: null as boolean | null, streaming: false as const, maxOutputTokens: null as number | null };
}

/** 生成 n 页、每页一行文字的最小 PDF（偏移量按实际字节计算） */
function makePdf(n: number): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 24 Tf 20 200 Td (Page ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const okProvider = (raw: string, over: Partial<ReturnType<typeof defaultCaps>> = {}, onCall?: (body: Record<string, unknown>) => void) =>
  new OpenAICompatibleProvider(
    { ...baseCfg, capabilities: caps(over) },
    fakeFetch(async (init) => {
      onCall?.(JSON.parse(String(init?.body)));
      return Response.json({ id: "chatcmpl-fake-001", choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    }),
  );

describe("R-02 输入覆盖清单", () => {
  it("AT-23 PDF 25 页、只能发 20 页：清单标出 20/25，不是完整输入", async () => {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "查货25页.pdf", buffer: makePdf(25), materialType: "INSPECTION" }] });
    let images = 0;
    setProviderForTests(okProvider(fx("v3/SC-08/P2").raw, {}, (b) => (images = ((b.messages as { content: unknown }[])[1].content as unknown[]).length - 1)));
    const pre = await previewModelRun({ promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", attachImages: true });
    expect(pre.ok && pre.manifest.page_coverage).toBe("20/25");
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {}, attachImages: true });
    setProviderForTests(undefined);
    expect(images).toBe(20);
    const m = run.input_manifest!;
    expect(m.page_coverage).toBe("20/25");
    expect(m.sent_image_count).toBe(20);
    expect(m.complete).toBe(false);
    expect(m.visual_evidence).toBe("PARTIAL");
    expect(m.truncation_reason).toMatch(/20\/25/);
    expect(m.files[0]).toMatchObject({ total_pages: 25, original_file_hash: expect.stringMatching(/^[0-9a-f]{64}$/), preprocessor_version: expect.stringMatching(/pdftotext/) });
    expect(m.files[0].text_pages.length).toBe(25);
  }, 60000);

  it("AT-24 只发文本不发图：标出视觉证据未送入", async () => {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "手写查货.pdf", buffer: makePdf(2), materialType: "INSPECTION" }] });
    setProviderForTests(okProvider(fx("v3/SC-08/P2").raw));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    setProviderForTests(undefined);
    expect(run.input_manifest!.visual_evidence).toBe("NOT_SENT");
    expect(run.input_manifest!.sent_image_count).toBe(0);
    expect(run.input_manifest!.notes.join()).toMatch(/不能检验视觉识别/);
  });

  it("AT-25 Excel 多 Sheet：清单列出每个 Sheet 的行列", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["型号", "数量"], ["ABC-01", 10], ["XYZ-02", 5]]), "委托");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["发票号", "单价"], ["INV-1", 11]]), "发票");
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "委托.xlsx", buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), materialType: "ORDER" }] });
    const pre = await previewModelRun({ promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}" });
    expect(pre.ok).toBe(true);
    const f = pre.ok ? pre.manifest.files[0] : undefined;
    expect(f?.sheets).toEqual([
      { name: "委托", rows: 3, columns: 2, cells: 6 },
      { name: "发票", rows: 2, columns: 2, cells: 4 },
    ]);
    expect(pre.ok && pre.manifest.complete).toBe(true);
    expect(pre.ok && pre.manifest.visual_evidence).toBe("NOT_APPLICABLE");
  });

  it("上游 JSON（P3 录制请求）：没有原件，记录来源快照", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P3"))!;
    const pre = await previewModelRun({ promptId: "jiuli-p3", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}" });
    expect(pre.ok && pre.manifest).toMatchObject({ files: [], snapshot_id: snap.snapshot_id, snapshot_source_type: "FIXTURE", complete: true });
  });
});

describe("R-03 / R-04 运行前阻断", () => {
  const snap = () => snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;

  it("AT-26 模板里有未登记变量：预览报错，运行被拒绝且模型未被调用", async () => {
    let called = false;
    setProviderForTests(okProvider("{}", {}, () => (called = true)));
    const tpl = "客户：{{customer_name}}\n{{input_json}}";
    const pre = await previewModelRun({ promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: tpl });
    expect(pre.ok && pre.blockers.map((b) => b.code)).toEqual(["UNRESOLVED_TEMPLATE_VARIABLE"]);
    await expect(modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: tpl, params: {} })).rejects.toMatchObject({ code: "UNRESOLVED_TEMPLATE_VARIABLE" });
    expect(called).toBe(false);
    setProviderForTests(undefined);
  });

  it("AT-27 模型声明不支持图片 / 参数不合法：显示能力错误，不调用、不返回 Mock 成功", async () => {
    let called = false;
    setProviderForTests(okProvider("{}", { images: false, maxOutputTokens: 8000 }, () => (called = true)));
    const base = { projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "S", userTemplate: "{{input_json}}" };
    await expect(modelRun({ ...base, params: {}, attachImages: true })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(modelRun({ ...base, params: { max_tokens: 16000 } })).rejects.toMatchObject({ code: "MODEL_PARAM_INVALID" });
    await expect(modelRun({ ...base, params: { temperature: 5 } })).rejects.toMatchObject({ code: "MODEL_PARAM_INVALID" });
    await expect(modelRun({ ...base, params: { frequency_penalty: 1 } })).rejects.toMatchObject({ code: "MODEL_PARAM_UNSUPPORTED" });
    expect(called).toBe(false);
    setProviderForTests(undefined);
  });

  it("预览：脱敏、给出参数与 token 粗估", async () => {
    setProviderForTests(okProvider("{}"));
    const pre = await previewModelRun({ promptId: "jiuli-p1", snapshotId: snap().snapshot_id, system: "密钥 sk-abcdefghijklmnop 不应出现", userTemplate: "{{input_json}}", params: { temperature: 0 } });
    setProviderForTests(undefined);
    expect(pre.ok && pre.system).not.toContain("sk-abcdefghijklmnop");
    expect(pre.ok && pre.params).toEqual({ temperature: 0 });
    expect(pre.ok && pre.tokenEstimate).toBeGreaterThan(100);
  });
});

describe("R-04 / R-05 运行诊断、重试", () => {
  it("记录分阶段耗时与服务商请求 ID", async () => {
    setProviderForTests(okProvider(fx("v3/SC-08/P1").raw));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    setProviderForTests(undefined);
    expect(run.provider_request_id).toBe("chatcmpl-fake-001");
    expect(run.timing).toMatchObject({ preprocess_ms: null, inference_ms: expect.any(Number), parse_ms: expect.any(Number) });
    expect(run.input_manifest?.complete).toBe(true);
  });

  it("AT-28 失败 Run 原样重试：同输入同提示词，新建 Run，原失败记录不变", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    setProviderForTests(new OpenAICompatibleProvider({ ...baseCfg, capabilities: caps() }, fakeFetch(async () => new Response("boom", { status: 500 }))));
    const failed = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "SYS", userTemplate: "{{input_json}}", params: { temperature: 0 } });
    expect(failed.status).toBe("MODEL_ERROR");
    setProviderForTests(okProvider(fx("v3/SC-08/P1").raw));
    const retried = await retryRun(failed.run_id).done;
    setProviderForTests(undefined);
    expect(retried.status).toBe("SUCCEEDED");
    expect(retried.retry_of_run_id).toBe(failed.run_id);
    expect(retried.built_input_hash).toBe(failed.built_input_hash);
    expect(retried.actual_prompt_hash).toBe(failed.actual_prompt_hash);
    expect(retried.model_params).toEqual({ temperature: 0 });
    expect(getRun(failed.run_id)!.status).toBe("MODEL_ERROR");
  });
});

describe("R-08 ~ R-11 视图补齐", () => {
  const pipe = (id: string, mutate?: (doc: any) => void) => {
    const f = fx(id);
    const doc = JSON.parse(f.raw);
    mutate?.(doc);
    return runPipeline({ raw: JSON.stringify(doc), promptKind: f.promptKind, context: { runId: "t", request: f.request, gold: f.gold, baseDraft: f.baseDraft } });
  };
  const codes = (r: ReturnType<typeof pipe>) => r.viewModel!.diagnostics.map((d) => d.code);

  it("AT-11 P3 请求候选池：列出模型收到的全部候选，未被提及的标出；召回缺失可从池中看出", () => {
    const r = pipe("constructed/p3-v3-multi-candidate.json", (d) => {
      d.output.row_relations[1].candidate_groups.pop(); // 去掉 IR_C3 → 池中仍有但未被提及
    });
    const pool = r.viewModel!.tables.find((t) => t.id === "requestCandidates")!;
    expect(pool.rows.map((x) => x.cells.raw_row_id.value)).toEqual(["IR_A1", "IR_B1", "IR_C1", "IR_C2", "IR_C3", "IR_D1"]);
    const c3 = pool.rows.find((x) => x.cells.raw_row_id.value === "IR_C3")!;
    expect(c3.cells.mention.value).toBe("未被任何委托行提及");
    expect(c3.cells.model.jsonPointer).toMatch(/^req:\/input\/inspection_candidates\/4\/identity\/model$/);
    expect(pool.rows.find((x) => x.cells.raw_row_id.value === "IR_A1")!.cells.selected_by.value).toBe("OR_001");
    // OR_003（NEW-77）UNMATCHED：池中没有同型号候选 → 属于召回 / 输入构造问题，而不是模型裁决
    expect(pool.rows.some((x) => x.cells.model.value === "NEW-77")).toBe(false);
  });

  it("P3 契约一致性：多候选不足两组、同一原始行被两个 MATCHED 选中、COMPLETE 非 DISJOINT", () => {
    const r = pipe("constructed/p3-v3-multi-candidate.json", (d) => {
      d.output.row_relations[1].candidate_groups = [d.output.row_relations[1].candidate_groups[0]];
      d.output.row_relations[3].selected_raw_row_ids = ["IR_A1"];
      d.output.row_relations[0].coverage.overlap = "UNKNOWN";
    });
    expect(codes(r)).toEqual(expect.arrayContaining(["MULTIPLE_CANDIDATES_LT_2", "RAW_ROW_MATCHED_TWICE", "COMPLETE_NOT_DISJOINT"]));
  });

  it("AT-07 P2 v3 范围 PARTIAL / UNCERTAIN 进入问题区，不伪造入仓号", () => {
    const r = pipe("v3/SC-08/P2", (d) => (d.output.logical_inspections[0].range_status = "PARTIAL"));
    const issue = r.viewModel!.issues.find((i) => i.type === "RANGE_PARTIAL")!;
    expect(issue.target).toMatchObject({ tableId: "logicalInspections", fieldKey: "range_status", jsonPointer: "/output/logical_inspections/0/range_status" });
  });

  it("AT-14 / AT-16 P4 矩阵：未核验字段不当作空，锁定字段标出；决策附中文说明", () => {
    const r = pipe("constructed/p4-v3-conflict.json");
    const m = r.viewModel!.tables.find((t) => t.id === "fieldMatrix")!;
    expect(m.columns).toHaveLength(26);
    const values = m.rows.flatMap((row) => Object.values(row.cells).map((c) => String(c.value)));
    expect(values.some((v) => v.startsWith("本轮未核验"))).toBe(true);
    expect(values.some((v) => v.includes("【锁定】"))).toBe(true);
    const dec = r.viewModel!.tables.find((t) => t.id === "fieldDecisions")!;
    expect(dec.rows.map((x) => String(x.cells.verification_status.value))).toContain("NO_EVIDENCE（未取得证据）");
    // 锁定字段不进入可模拟应用集合
    const locked = dec.rows.find((x) => x.meta?.locked)!;
    expect(r.viewModel!.changes.find((c) => c.id === locked.id)!.simulation!.applicable).toBe(false);
    expect(locked.cells.write_policy.jsonPointer.startsWith("req:")).toBe(true);
  });
});

describe("R-13 Excel 来源定位", () => {
  it("证据卡从快照预处理文本取出该行单元格，不按文件名找原件", async () => {
    const { excelRowExcerpt } = await import("@/components/renderers/evidence-viewer");
    const req = fx("v3/SC-08/P1").request;
    const cells = excelRowExcerpt(req, { fileId: "F-3c3cc10bd26b", sheet: "12-10-2", row: 7 });
    expect(cells?.find((c) => c.column === "D")?.value).toBe("H25G9TCXXCX702A#9");
    expect(excelRowExcerpt(req, { fileId: "F-不存在", sheet: "12-10-2", row: 7 })).toBeNull();
  });
});

describe("R-14 独立人工纠错标注", () => {
  const post = async (runId: string, body: unknown) => {
    const { POST } = await import("@/app/api/runs/[id]/annotations/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { params: Promise.resolve({ id: runId }) } as never);
    return { status: res.status, json: (await res.json()) as { ok: boolean; data: Record<string, unknown>; error?: { message: string } } };
  };

  it("AT-31 标注 P2 产地正确值：写 Annotation（含模型原值、归因、标注人），raw_response 完全不变", async () => {
    const { renderOnly } = await import("@/lib/runs/service");
    const f = fx("v3/SC-08/P2");
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p2", raw: f.raw, snapshotId: snapshotForFixture("jiuli", f)!.snapshot_id });
    const before = getRun(run.run_id)!;
    const pointer = "/output/raw_rows/0/origin_candidates/0/value";
    const r = await post(run.run_id, { assessment: "WRONG", error_category: "MODEL_EXTRACTION", category_confirmed: false, expected_value: "马来西亚", target_json_pointer: pointer, target: "inspectionRawRows / r1 / origin", source_ref_ids: ["ev-1"] });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ issue_type: "ASSESSMENT", assessment: "WRONG", error_category: "MODEL_EXTRACTION", category_confirmed: false, expected_value: "马来西亚", source_ref_ids: ["ev-1"], author: "本机用户" });
    expect(JSON.parse(String(r.json.data.model_value))).toBe(JSON.parse(f.raw).output.raw_rows[0].origin_candidates[0].value);
    const after = getRun(run.run_id)!;
    expect(after.raw_response).toBe(before.raw_response);
    expect(after.raw_response_hash).toBe(before.raw_response_hash);
  });

  it("标注错误必须给归因；标注正确不能带归因；请求输入位置不记模型原值", async () => {
    const { renderOnly } = await import("@/lib/runs/service");
    const f = fx("v3/SC-08/P1");
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: f.raw, snapshotId: snapshotForFixture("jiuli", f)!.snapshot_id });
    expect((await post(run.run_id, { assessment: "WRONG" })).status).toBe(400);
    expect((await post(run.run_id, { assessment: "CORRECT", error_category: "PROMPT_RULE" })).status).toBe(400);
    const ok = await post(run.run_id, { assessment: "UNSURE", target_json_pointer: "req:/input/materials/0/file_id" });
    expect(ok.status).toBe(201);
    expect(ok.json.data.model_value).toBeNull();
    expect(ok.json.data.category_confirmed).toBe(true);
  });
});

describe("R-07 同样本双 Run 比较", () => {
  const twoRuns = async (rawB: string, attachB = false) => {
    const f = fx("v3/SC-08/P1");
    const snap = snapshotForFixture("jiuli", f)!;
    setProviderForTests(okProvider(f.raw));
    const a = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: { temperature: 0 } });
    setProviderForTests(okProvider(rawB));
    const b = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S2", userTemplate: "{{input_json}}", params: { temperature: 0 } });
    setProviderForTests(undefined);
    return { a, b: attachB ? { ...b, attached_images: [{ file_id: "F-x", page: 1, media_type: "image/jpeg", sha256: "abcdef0123" }] } : b };
  };

  it("AT-33 两次 Run 输入条件一致：判定为严格同条件，并准确列出字段差异", async () => {
    const { compareRuns, diffSummary } = await import("@/components/playground/run-compare");
    const raw = JSON.parse(fx("v3/SC-08/P1").raw);
    raw.output.rows[0].values.origin = "马来西亚（改）";
    const { a, b } = await twoRuns(JSON.stringify(raw));
    expect(compareRuns(a, b).strict).toEqual({ applicable: true, strict: true, reasons: [] });
    const d = diffSummary(a.parsed_json, b.parsed_json);
    expect(d.rows.filter((r) => r.kind === "CHANGED").map((r) => r.pointer)).toEqual([expect.stringMatching(/\/output\/rows\/\[.*\]\/values\/origin$/)]);
    expect(d.same).toBeGreaterThan(20);
  });

  it("AT-34 预处理版本 / 附带图片不同：不满足严格同条件，不直接算退化", async () => {
    const { strictConditions } = await import("@/components/playground/run-compare");
    const { a, b } = await twoRuns(fx("v3/SC-08/P1").raw, true);
    // 构造输入 Hash 相同，但一边附带了图片：审计发现的误导场景
    expect(a.built_input_hash).toBe(b.built_input_hash);
    expect(strictConditions(a, b)).toMatchObject({ strict: false, reasons: ["附带原件图片不同"] });
    const pre = { ...b, attached_images: a.attached_images, input_manifest: { ...b.input_manifest!, files: [{ ...b.input_manifest!.files[0], preprocessor_version: "file-import@2.0.0" }] } };
    expect(strictConditions(a, pre).reasons).toEqual(["预处理版本不同"]);
  });
});
