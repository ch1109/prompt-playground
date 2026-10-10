// v1.1 验收（AT-01 ~ AT-36 中服务端 / 纯函数层可验证的部分）。界面用例见 e2e/v1.1.spec.ts。
// 所有模型调用都用本地假服务，不代表真实模型已运行。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
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
