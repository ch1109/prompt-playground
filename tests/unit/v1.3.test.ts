// v1.3 M1：Run 证据采集、采集完整度、标注修订等服务端 / 纯函数层验收。界面联动见 e2e/v1.3.spec.ts。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findAdapter } from "@/lib/adapters/registry";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { addAnnotation, checkAssessment, deleteAnnotation, fixtureRunStats, getAnnotation, listAnnotations, updateAnnotation } from "@/lib/repositories/runs";
import { buildInputManifest } from "@/lib/runs/input-manifest";
import { captureQuality, diagnosticStates, fieldInputCoverage } from "@/lib/runs/run-evidence";
import type { EvidenceView } from "@/lib/contracts/view-model";
import { modelRun, renderOnly } from "@/lib/runs/service";

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-v13-mat-"));
});
afterEach(() => setProviderForTests(undefined));

function fx(id: string) {
  const f = getFixture(id);
  if (!f) throw new Error(`fixture ${id} 不存在`);
  return f;
}

const API_KEY = "sk-test-secret-v13-abcdef";
/** 假服务商：返回固定内容，并记录真正发出的请求体 */
function fakeProvider(raw: string, onCall?: (body: Record<string, unknown>) => void) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: API_KEY, timeoutMs: 2000, capabilities: { images: true, nativePdf: false, jsonMode: null, thinking: null, streaming: false, maxOutputTokens: null } },
    (async (_url: string, init?: RequestInit) => {
      onCall?.(JSON.parse(String(init?.body)));
      return Response.json({
        id: "chatcmpl-v13",
        model: "fake-model-2026-10",
        created: 1760000000,
        choices: [{ message: { content: raw, reasoning_content: "模型的思考过程" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 7 } },
      });
    }) as unknown as typeof fetch,
  );
}

// 1×1 像素 PNG
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("M1-2 新 Run 采集完整执行证据", () => {
  it("实际请求的脱敏副本：有结构和参数，没有密钥、没有图片 base64，图片部件指明原件", async () => {
    const { createFileSnapshot } = await import("@/lib/materials/store");
    const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "查货照片.png", buffer: PNG_1PX, materialType: "INSPECTION" }] });
    let sentBody = "";
    setProviderForTests(fakeProvider(fx("v3/SC-08/P2").raw, (b) => (sentBody = JSON.stringify(b))));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: { temperature: 0 }, attachImages: true });
    // 真正发出的请求里有图片，Run 里存的副本没有
    expect(sentBody).toContain("data:image/png;base64,");
    const req = JSON.stringify(run.request_actual);
    expect(req).not.toContain("base64,");
    expect(req).not.toContain(API_KEY);
    expect(run.request_actual).toMatchObject({ endpoint: "/chat/completions", model: "fake-model", temperature: 0, stream: false });
    const user = (run.request_actual!.messages as { role: string; content: unknown }[])[1];
    const parts = user.content as Record<string, unknown>[];
    expect(parts[0]).toMatchObject({ type: "text", text_chars: run.actual_prompt!.user.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(parts[1]).toMatchObject({ type: "image_url", media_type: "image/png", file_id: expect.any(String), page: null, sha256: run.attached_images![0].sha256 });
    // 构造输入的副本、服务商回报的模型名与原样 usage；思考内容全文单独保存（2026-10-14 起，用户要导出完整思考），实际请求副本里没有
    expect(run.built_input).toMatchObject({ input: expect.any(Object) });
    expect(run.response_meta).toMatchObject({ id: "chatcmpl-v13", model: "fake-model-2026-10", finish_reason: "stop", reasoning_content_chars: 7, usage: { completion_tokens_details: { reasoning_tokens: 7 } } });
    expect(run.reasoning_content).toBe("模型的思考过程");
    expect(JSON.stringify(run.request_actual)).not.toContain("模型的思考过程");
  });

  it("模型调用失败时也保存实际请求副本与构造输入", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    setProviderForTests(new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: API_KEY, timeoutMs: 2000 }, (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(run.status).toBe("MODEL_ERROR");
    expect(run.request_actual).toMatchObject({ endpoint: "/chat/completions" });
    expect(run.built_input).toBeTruthy();
  });

  it("P3 / P4 说明没有上游 Run，而不是留空", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P3"))!;
    setProviderForTests(fakeProvider(fx("v3/SC-08/P3").raw));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p3", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(run.upstream_run_ids).toEqual([]);
    expect(run.upstream_note).toMatch(/快照/);
  });

  it("Adapter 抛异常（ADAPTER_ERROR）时诊断照样保存", () => {
    const adapter = findAdapter("JIULI_P1", "jiuli-ai-v3")!;
    const spy = vi.spyOn(adapter, "adapt").mockImplementation(() => {
      throw new Error("模拟映射崩溃");
    });
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    spy.mockRestore();
    expect(run.status).toBe("ADAPTER_ERROR");
    expect(run.view_model).toBeNull();
    expect(run.adapter_diagnostics?.map((d) => d.code)).toContain("ADAPTER_EXCEPTION");
  });
});

describe("M1-2 输入清单 1.1：未进入模型的页、转换失败", () => {
  const snapshot = { snapshot_id: "snap_t", source_type: "FILE_IMPORT", content_hash: "h", normalized_payload: {}, materials: [{ file_id: "F1", file_name: "a.pdf", media_type: "application/pdf", content_hash: "x", availability: "AVAILABLE" }] } as unknown as InputSnapshot;
  const base = { snapshot, builderId: "b", builderVersion: "1", blockedFiles: [], attachImages: true, fileMeta: [], userChars: 1, systemChars: 1, visionSupported: true };

  it("没发文本、只发了前 3 页图：第 4、5 页记为未进入模型；text_pages 为空", () => {
    const m = buildInputManifest({ ...base, request: { input: { files: [{ file_id: "F1", content: null, segments: ["page:1", "page:2"] }] } }, imageCoverage: [{ file_id: "F1", media_type: "application/pdf", total_pages: 5, sent_pages: [1, 2, 3], skipped_reason: null }] });
    expect(m.version).toBe("input-manifest@1.1.0");
    expect(m.files[0].text_sent).toBe(false);
    expect(m.files[0].text_pages).toEqual([]);
    expect(m.files[0].omitted_pages).toEqual([4, 5]);
  });

  it("发了文本却不知道是哪几页：未进入模型的页记为未知（null），不猜", () => {
    const m = buildInputManifest({ ...base, request: { input: { files: [{ file_id: "F1", content: "全文" }] } }, imageCoverage: [{ file_id: "F1", media_type: "application/pdf", total_pages: 5, sent_pages: [1], skipped_reason: null }] });
    expect(m.files[0].omitted_pages).toBeNull();
  });

  it("原件转图失败记入 conversion_failures", () => {
    const m = buildInputManifest({ ...base, request: { input: { files: [{ file_id: "F1", content: null }] } }, imageCoverage: [{ file_id: "F1", media_type: null, total_pages: null, sent_pages: [], skipped_reason: "无法读取原件（坏文件）", conversion_failed: true }] });
    expect(m.conversion_failures).toEqual([{ file_id: "F1", reason: "无法读取原件（坏文件）" }]);
    expect(m.files[0].omitted_pages).toBeNull();
  });
});

describe("M1-3 采集完整度与诊断状态（读取时推导）", () => {
  it("v1.3 起的模型运行：采集完整；状态为模型响应成功 + 未评测", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    setProviderForTests(fakeProvider(fx("v3/SC-08/P1").raw));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    const c = captureQuality(run);
    expect(c.not_captured).toEqual([]);
    expect(c.quality).toBe("COMPLETE");
    const { states, warnings } = diagnosticStates(run, { activeSchemaVersion: "jiuli-ai-v3", hasGold: false });
    expect(states.map((s) => s.code)).toEqual(["MODEL_RUN_SUCCESS", "EVAL_NOT_AVAILABLE"]);
    expect(warnings).toEqual([]);
  });

  it("RUN-09 旧 Run 没有记录实际请求：判为不完整并逐项说明，不补造", async () => {
    const snap = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    setProviderForTests(fakeProvider(fx("v3/SC-08/P1").raw));
    const fresh = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    // 模拟 v1.1 之前的记录：只有展开后的提示词，没有请求副本、清单、计时等
    const { request_actual: _a, response_meta: _b, built_input: _c, input_manifest: _d, timing: _e, prompt_source: _f, adapter_diagnostics: _g, ...old } = fresh;
    const c = captureQuality(old);
    expect(c.quality).toBe("PARTIAL");
    expect(c.not_captured.map((n) => n.key)).toEqual(["prompt_source", "request_actual", "response_meta", "built_input", "input_manifest", "timing", "adapter_diagnostics"]);
    expect(c.not_captured.every((n) => n.limitation.length > 0)).toBe(true);
  });

  it("仅渲染不评估采集完整度；未登记的 schema_version 判为结构未登记", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("constructed/unknown-schema-version.json").raw });
    expect(captureQuality(run).quality).toBe("NOT_APPLICABLE");
    const { states } = diagnosticStates(run, { activeSchemaVersion: "jiuli-ai-v3", hasGold: false });
    expect(states.find((s) => s.code === "SCHEMA_INVALID")?.label).toBe("结构未登记");
    expect(states.map((s) => s.code)).not.toContain("MODEL_RUN_SUCCESS");
  });

  it("输出版本与提示词登记的版本不一致时给出警告；有 Gold 时不报未评测", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v2/p1-original-output-example.json").raw });
    const { states, warnings } = diagnosticStates(run, { activeSchemaVersion: "jiuli-ai-v3", hasGold: true });
    expect(warnings.map((w) => w.code)).toEqual(["SCHEMA_VERSION_MISMATCH"]);
    expect(warnings[0].reason).toMatch(/jiuli-ai-v3.*jiuli-ai-v2/);
    expect(states.map((s) => s.code)).not.toContain("EVAL_NOT_AVAILABLE");
  });
});

describe("M1-4 标注修订留痕 + 13 类错误归因", () => {
  const base = { target_json_pointer: "/output/rows/0/values/origin", target: "orderRows / row-1 / origin", issue_type: "ASSESSMENT", note: null, source_ref_ids: [], author: "测试员" };
  const revisionRows = (id: string) => db().prepare("SELECT revision, action, body FROM annotation_revisions WHERE annotation_id = ? ORDER BY revision").all(id) as { revision: number; action: string; body: string }[];

  it("RUN-07 新增、修改、删除各留一版；第 1 版保留原值；原始响应 hash 始终不变", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    const rawHash = () => (db().prepare("SELECT sha256 FROM raw_responses WHERE run_id = ?").get(run.run_id) as { sha256: string }).sha256;
    const before = rawHash();
    const a = addAnnotation({ ...base, run_id: run.run_id, expected_value: "日本", assessment: "WRONG", error_category: "OCR_VISION_ERROR", category_confirmed: false });
    expect(a.revision).toBe(1);
    updateAnnotation(a.annotation_id, { issue_type: "ASSESSMENT", expected_value: "韩国", note: null, assessment: "WRONG", error_category: "INPUT_MISSING_PAGE" });
    const mid = getAnnotation(a.annotation_id)!;
    expect(mid.revision).toBe(2);
    expect(mid.revisions!.map((r) => [r.action, r.body.expected_value, r.body.error_category])).toEqual([
      ["CREATE", "日本", "OCR_VISION_ERROR"],
      ["UPDATE", "韩国", "INPUT_MISSING_PAGE"],
    ]);
    expect(deleteAnnotation(a.annotation_id)).toBe(true);
    expect(listAnnotations(run.run_id)).toEqual([]);
    expect(revisionRows(a.annotation_id).map((r) => r.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
    expect(rawHash()).toBe(before);
  });

  it("修订记录只能追加：改写或删除都被数据库拒绝", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    const a = addAnnotation({ ...base, run_id: run.run_id, expected_value: "x", assessment: "UNSURE", error_category: null });
    expect(() => db().prepare("UPDATE annotation_revisions SET body = '{}' WHERE annotation_id = ?").run(a.annotation_id)).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM annotation_revisions WHERE annotation_id = ?").run(a.annotation_id)).toThrow(/只追加/);
  });

  it("v1.3 之前的旧标注第一次修改时，先补一版原始内容再记修改", () => {
    const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    db()
      .prepare("INSERT INTO annotations (annotation_id, run_id, target_json_pointer, target, issue_type, expected_value, note, created_at, assessment, error_category, source_ref_ids) VALUES ('ann_legacy', ?, NULL, NULL, 'ASSESSMENT', '旧值', NULL, '2026-10-09T00:00:00.000Z', 'WRONG', 'MODEL_EXTRACTION', '[]')")
      .run(run.run_id);
    expect(getAnnotation("ann_legacy")!.revision).toBe(1);
    updateAnnotation("ann_legacy", { issue_type: "ASSESSMENT", expected_value: "新值", note: null });
    expect(getAnnotation("ann_legacy")!.revisions!.map((r) => [r.revision, r.action, r.body.expected_value])).toEqual([
      [1, "CREATE", "旧值"],
      [2, "UPDATE", "新值"],
    ]);
  });

  it("错误归因：接受 13 类新值，旧 8 类仍可读写，其他值拒绝", () => {
    expect(checkAssessment({ assessment: "WRONG", error_category: "RELATION_SELECTION_ERROR" })).toBeNull();
    expect(checkAssessment({ assessment: "WRONG", error_category: "MATCH_JUDGEMENT" })).toBeNull();
    expect(checkAssessment({ assessment: "WRONG", error_category: "SOMETHING_ELSE" as never })).toMatch(/UNKNOWN/);
    expect(checkAssessment({ assessment: "WRONG", error_category: null })).toMatch(/UNKNOWN/);
  });
});

describe("M1-5 字段级实际输入", () => {
  const ev = (over: Partial<EvidenceView>): EvidenceView => ({ id: "ev", fileId: "F1", fileName: "查货.pdf", page: 2, availability: "AVAILABLE", ...over }) as EvidenceView;
  const manifest = buildInputManifest({
    request: { input: { files: [{ file_id: "F1", content: null }] } },
    snapshot: { snapshot_id: "s", source_type: "FILE_IMPORT", content_hash: "h", normalized_payload: {}, materials: [] } as unknown as InputSnapshot,
    builderId: "b",
    builderVersion: "1",
    blockedFiles: [],
    attachImages: true,
    imageCoverage: [{ file_id: "F1", media_type: "application/pdf", total_pages: 3, sent_pages: [1, 2], skipped_reason: null }],
    fileMeta: [],
    userChars: 1,
    systemChars: 1,
    visionSupported: true,
  });

  it("页图发了 / 页没进模型 / 文件不在请求里 / 旧 Run 没有清单，分别说明", () => {
    const [sent, omitted, absent] = fieldInputCoverage([ev({ id: "a", page: 2 }), ev({ id: "b", page: 3 }), ev({ id: "c", fileId: "F9", fileName: "发票.pdf" })], manifest, "MODEL_RUN");
    expect(sent).toMatchObject({ status: "IMAGE_SENT", text: "查货.pdf 第 2 页：页图已发送给模型" });
    expect(omitted).toMatchObject({ status: "NOT_SENT", text: "查货.pdf 第 3 页：这一页没有进入模型" });
    expect(absent.status).toBe("NOT_SENT");
    expect(fieldInputCoverage([ev({})], null, "MODEL_RUN")[0]).toMatchObject({ status: "UNKNOWN", text: expect.stringContaining("未记录") });
    expect(fieldInputCoverage([ev({})], manifest, "RENDER_ONLY")[0].text).toContain("没有调用模型");
  });
});

describe("M1-6 样本运行统计", () => {
  it("按项目统计样本的运行次数、最近运行时间与标为错误的标注数", () => {
    const f = fx("constructed/p4-v3-conflict.json");
    const snap = snapshotForFixture("stats-proj", f)!;
    const r1 = renderOnly({ projectId: "stats-proj", promptId: "jiuli-p4", raw: f.raw, snapshotId: snap.snapshot_id });
    const r2 = renderOnly({ projectId: "stats-proj", promptId: "jiuli-p4", raw: f.raw, snapshotId: snap.snapshot_id });
    addAnnotation({ run_id: r1.run_id, target_json_pointer: null, target: null, issue_type: "ASSESSMENT", expected_value: null, note: null, assessment: "WRONG", error_category: "UNKNOWN" });
    addAnnotation({ run_id: r2.run_id, target_json_pointer: null, target: null, issue_type: "ASSESSMENT", expected_value: null, note: null, assessment: "CORRECT", error_category: null });
    const st = fixtureRunStats("stats-proj").get(f.id)!;
    expect(st).toMatchObject({ run_count: 2, wrong_count: 1 });
    expect(st.last_run_at).toBe(r2.started_at);
    // 其他项目的运行不计入
    expect(fixtureRunStats("other-proj").get(f.id)).toBeUndefined();
  });
});

describe("M1-8 版本对比的输入可比性", () => {
  it("同一样本可比；不同样本、没有输入记录、预处理未记录都判为不可直接比较", async () => {
    const { inputComparability } = await import("@/components/playground/run-compare");
    const snapA = snapshotForFixture("jiuli", fx("v3/SC-08/P1"))!;
    const snapB = snapshotForFixture("jiuli", fx("v3/SC-08-audit/P1"))!;
    const a1 = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw, snapshotId: snapA.snapshot_id });
    const a2 = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw, snapshotId: snapA.snapshot_id });
    const b = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08-audit/P1").raw, snapshotId: snapB.snapshot_id });
    const pasted = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: fx("v3/SC-08/P1").raw });
    expect(inputComparability(a1, a2)).toEqual({ comparable: true, reasons: [] });
    expect(inputComparability(a1, b).reasons).toEqual(["两次运行用的输入不同（样本或输入快照不同）"]);
    expect(inputComparability(a1, pasted).reasons[0]).toMatch(/没有输入记录/);
    // 两次真实运行：同一输入，但一方没有预处理记录（旧 Run）
    setProviderForTests(fakeProvider(fx("v3/SC-08/P1").raw));
    const m1 = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapA.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    const m2 = await modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapA.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {} });
    expect(inputComparability(m1, m2).comparable).toBe(true);
    expect(inputComparability(m1, { ...m2, input_manifest: null }).reasons).toEqual(["至少一方没有预处理记录（v1.1 之前的运行）"]);
  });
});
