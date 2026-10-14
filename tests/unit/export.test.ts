// 一键导出运行上下文：保存模型思考全文；ZIP 里的 Markdown（输入、提示词、思考、输出、标注、检查）与原件
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Run } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createFileSnapshot, resolveMaterialFile } from "@/lib/materials/store";
import { resetDbForTests } from "@/lib/repositories/db";
import { addAnnotation, getRun } from "@/lib/repositories/runs";
import { loadRunContext } from "@/lib/runs/debug-bundle";
import { contextMarkdown, exportZip } from "@/lib/runs/export";
import { modelRun, renderOnly } from "@/lib/runs/service";
import { makePdf } from "./helpers/pdf";

const THINKING = "先看委托表第 7 行，产地一栏写的是韩国……";

/** 模拟服务商：返回指定输出，可附带思考内容 */
const provider = (raw: string, reasoning?: string) =>
  new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-export-abc", timeoutMs: 5000 }, (async () =>
    Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: raw, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch);

const runP1 = (reasoning?: string, opts: { raw?: string; system?: string } = {}): Promise<Run> => {
  setProviderForTests(provider(opts.raw ?? getFixture("v3/SC-08/P1")!.raw, reasoning));
  return modelRun({ projectId: "jiuli", promptId: "jiuli-p1", snapshotId: snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id, system: opts.system ?? "系统提示词", userTemplate: "请识别：{{input_json}}", params: { temperature: 0 } });
};
const md = (run: Run) => contextMarkdown(loadRunContext(run.run_id)!, []);

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-export-mat-"));
});
afterEach(() => setProviderForTests(undefined));

describe("保存模型思考", () => {
  it("服务商返回思考内容时，新 Run 保存全文；没返回时为 null", async () => {
    const withThinking = await runP1(THINKING);
    expect(getRun(withThinking.run_id)!.reasoning_content).toBe(THINKING);
    expect(getRun(withThinking.run_id)!.response_meta).toMatchObject({ reasoning_content_chars: THINKING.length });
    const without = await runP1();
    expect(getRun(without.run_id)!.reasoning_content).toBeNull();
  });
});

describe("上下文 Markdown", () => {
  it("包含实际发送的 system 与 user 全文、模型思考、原始输出、人工标注（含正确值）与 Schema 错误位置", async () => {
    // Source.column 写成数字 → Schema 错误
    const broken = getFixture("v3/SC-08/P1")!.raw.replace(/"column":\s*"([A-Z]+)"/, '"column": 6');
    const run = await runP1(THINKING, { raw: broken, system: "你是九立委托识别助手。\n产地按委托书填写。" });
    addAnnotation({ run_id: run.run_id, target_json_pointer: "/output/rows/0/values/origin", target: "orderRows / row-1 / origin", issue_type: "ASSESSMENT", expected_value: "日本", note: "原件写的是日本", assessment: "WRONG", error_category: "PROMPT_RULE_ERROR", category_confirmed: null, model_value: '"韩国"', source_ref_ids: [], author: "我" });
    const text = md(getRun(run.run_id)!);
    for (const s of ["## 运行信息", "## 人工标注", "## 结构与规则检查", "## System 提示词", "## 用户输入", "## 模型思考", "## 模型输出", "## 原件"]) expect(text).toContain(s);
    expect(text).toContain("产地按委托书填写。");
    expect(text).toContain("请识别：{");
    expect(text).toContain(THINKING);
    expect(text).toContain(broken.slice(0, 200));
    expect(text).toMatch(/\*\*错\*\* · orderRows \/ row-1 \/ origin/);
    expect(text).toContain("正确值：日本");
    expect(text).toContain("模型原值：\"韩国\"");
    expect(text).toMatch(/SCHEMA_TYPE（`\/output\/[^`]*\/column`）：/);
    expect(text).not.toContain("sk-test-export-abc");
  });

  it("没有思考内容时如实说明：旧运行没保存 / 模型没返回 / 没调用模型", async () => {
    const run = await runP1();
    expect(md(getRun(run.run_id)!)).toContain("模型这次没有返回思考内容");
    const c = loadRunContext(run.run_id)!;
    const legacy = contextMarkdown({ ...c, run: { ...c.run, reasoning_content: undefined, response_meta: { reasoning_content_chars: 500 } } }, []);
    expect(legacy).toContain("模型这次思考了 500 个字符，但这次运行早于保存思考全文的功能");
    const rendered = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: getFixture("v3/SC-08/P1")!.raw, snapshotId: snapshotForFixture("jiuli", getFixture("v3/SC-08/P1")!)!.snapshot_id });
    expect(md(rendered)).toContain("这次没有调用模型，没有思考内容");
  });

  it("内容里自带 ``` 时，代码块围栏更长，不会被截断", async () => {
    const run = await runP1(undefined, { system: "输出格式：\n```json\n{}\n```\n结束" });
    const text = md(getRun(run.run_id)!);
    const section = text.slice(text.indexOf("## System 提示词"), text.indexOf("## 用户输入"));
    expect(section).toContain("````\n输出格式：\n```json\n{}\n```\n结束\n````");
  });
});

describe("导出 ZIP", () => {
  async function uploadedRun() {
    const pdf = makePdf(2);
    const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "扫描查货.pdf", buffer: pdf, materialType: "INSPECTION" }] });
    const fileId = snap.materials[0].file_id;
    setProviderForTests(provider(getFixture("v3/SC-08/P2")!.raw.split("F-8bc7177252aa").join(fileId), THINKING));
    const run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {}, attachImages: false });
    return { run, fileId, pdf };
  }

  it("包含 上下文.md 与 原件/（字节与原件一致），清单写明已打包", async () => {
    const { run, pdf } = await uploadedRun();
    const r = (await exportZip(run.run_id))!;
    expect(r.fileName).toBe(`上下文_P2_${run.run_id}.zip`);
    const files = unzipSync(r.zip);
    expect(Object.keys(files).sort()).toEqual(["上下文.md", "原件/扫描查货.pdf"]);
    expect(Buffer.from(files["原件/扫描查货.pdf"]).equals(pdf)).toBe(true);
    const text = strFromU8(files["上下文.md"]);
    expect(text).toContain(THINKING);
    expect(text).toMatch(/扫描查货\.pdf（U-[^）]+application\/pdf[^）]*）：已打包为 `原件\/扫描查货\.pdf`/);
  });

  it("原件读不到时导出照样成功，清单写明没打包的原因", async () => {
    const { run, fileId } = await uploadedRun();
    unlinkSync((await resolveMaterialFile(fileId)).absolutePath);
    const files = unzipSync((await exportZip(run.run_id))!.zip);
    expect(Object.keys(files)).toEqual(["上下文.md"]);
    expect(strFromU8(files["上下文.md"])).toMatch(/没有打包——/);
  });

  it("Run 不存在返回 undefined", async () => {
    expect(await exportZip("run_nope")).toBeUndefined();
  });
});
