// v1.2：看图默认附带、页数上限可配、文件夹上传、通用提示词。所有模型调用都用本地假服务。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { buildInput } from "@/lib/input-builders";
import { createFileSnapshot } from "@/lib/materials/store";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { resetDbForTests } from "@/lib/repositories/db";
import { maxPages } from "@/lib/runs/page-images";
import { effectiveAttachImages, modelRun } from "@/lib/runs/service";

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-v12-mat-"));
});

const caps = (images: boolean | null) => ({ images, nativePdf: false as const, jsonMode: null, thinking: null, streaming: false as const, maxOutputTokens: null });
const snap = (media: Record<string, string>) => ({ materials: Object.entries(media).map(([file_id, media_type]) => ({ file_id, media_type })) }) as unknown as InputSnapshot;
const req = (...ids: string[]) => ({ input: { files: ids.map((file_id) => ({ file_id })) } });

describe("看图默认附带", () => {
  const s = snap({ A: "application/pdf", B: "image/png", X: "application/vnd.ms-excel" });
  it("模型支持看图、输入有 PDF / 图片 → 自动附带", () => {
    expect(effectiveAttachImages(undefined, caps(true), req("A"), s)).toBe(true);
    expect(effectiveAttachImages(undefined, caps(true), req("X", "B"), s)).toBe(true);
  });
  it("只有 Excel、或模型未声明 / 不支持看图 → 不附带", () => {
    expect(effectiveAttachImages(undefined, caps(true), req("X"), s)).toBe(false);
    expect(effectiveAttachImages(undefined, caps(null), req("A"), s)).toBe(false);
    expect(effectiveAttachImages(undefined, caps(false), req("A"), s)).toBe(false);
  });
  it("用户明确勾选或取消时照办", () => {
    expect(effectiveAttachImages(false, caps(true), req("A"), s)).toBe(false);
    expect(effectiveAttachImages(true, caps(null), req("X"), s)).toBe(true);
  });
});

describe("页图上限可配", () => {
  it("默认 20，MODEL_MAX_IMAGE_PAGES 为正整数时生效，非法值回到默认", () => {
    expect(maxPages({})).toBe(20);
    expect(maxPages({ MODEL_MAX_IMAGE_PAGES: "50" })).toBe(50);
    expect(maxPages({ MODEL_MAX_IMAGE_PAGES: "abc" })).toBe(20);
    expect(maxPages({ MODEL_MAX_IMAGE_PAGES: "0" })).toBe(20);
  });
});

describe("文件夹上传", () => {
  it("按文件名猜材料类型，猜不出按提示词默认", async () => {
    const { guessMaterialType } = await import("@/lib/materials/guess-type");
    expect(guessMaterialType("单据/发票-INV001.pdf")).toBe("INVOICE");
    expect(guessMaterialType("Packing List 0923.xlsx")).toBe("PACKING_LIST");
    expect(guessMaterialType("PO-7788.pdf")).toBe("ORDER");
    expect(guessMaterialType("查货/A仓-手写.jpg")).toBe("INSPECTION");
    expect(guessMaterialType("发票/scan01.pdf")).toBe("INVOICE");
    expect(guessMaterialType("scan01.pdf", "JIULI_P2")).toBe("INSPECTION");
    expect(guessMaterialType("scan01.pdf")).toBe("ORDER");
  });
  it("隐藏文件、系统文件、不支持的格式被跳过并说明原因", async () => {
    const { skipReason } = await import("@/lib/materials/guess-type");
    expect(skipReason("资料/.DS_Store")).toMatch(/隐藏/);
    expect(skipReason("__MACOSX/资料/a.pdf")).toMatch(/隐藏/);
    expect(skipReason("资料/~$委托.xlsx")).toMatch(/隐藏/);
    expect(skipReason("资料/说明.docx")).toMatch(/不支持的格式 \.docx/);
    expect(skipReason("资料/子目录/委托.PDF")).toBeNull();
  });
  it("保留子文件夹相对路径，去掉绝对路径与 ..", async () => {
    const { safeRelativeName } = await import("@/lib/materials/store");
    expect(safeRelativeName("资料/发票/a.pdf")).toBe("资料/发票/a.pdf");
    expect(safeRelativeName("../../etc/a.pdf")).toBe("etc/a.pdf");
    expect(safeRelativeName("C:\\Users\\x\\a.pdf")).toBe("C:/Users/x/a.pdf");
    expect(safeRelativeName("/abs/a.pdf")).toBe("abs/a.pdf");
  });
});

describe("通用提示词", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-image")]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["型号"], ["GEN-01"]]), "S1");
  const xlsx = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  it("上传的全部文件放进 input.files（不分材料类型），模型支持看图时自动附带图片；纯文本回答算成功", async () => {
    const snap = await createFileSnapshot({ projectId: "jiuli", files: [{ name: "资料/图片.png", buffer: png, materialType: "ORDER" }, { name: "资料/表.xlsx", buffer: xlsx, materialType: "INSPECTION" }] });
    const built = buildInput("GENERIC_JSON", snap);
    expect(built.ok && built.builderId).toBe("file-import-generic");
    const files = (built.ok ? built.request : {}) as { input?: { files: { file_name: string; content: unknown }[] } };
    expect(files.input!.files.map((f) => f.file_name)).toEqual(["资料/图片.png", "资料/表.xlsx"]);
    expect(JSON.stringify(files.input!.files[1].content)).toContain("GEN-01");

    let images = -1;
    setProviderForTests(
      new OpenAICompatibleProvider(
        { baseUrl: "https://model.invalid/v1", model: "fake", apiKey: "sk-x", timeoutMs: 2000, capabilities: caps(true) },
        (async (_u: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          images = Array.isArray(body.messages[1].content) ? body.messages[1].content.length - 1 : 0;
          return Response.json({ choices: [{ message: { content: "图里写的是 GEN-01。" }, finish_reason: "stop" }] });
        }) as unknown as typeof fetch,
      ),
    );
    const run = await modelRun({ projectId: "jiuli", promptId: "generic-json", snapshotId: snap.snapshot_id, system: "描述文件内容", userTemplate: "{{input_json}}", params: {} });
    setProviderForTests(undefined);
    expect(images).toBe(1);
    expect(run.status).toBe("SUCCEEDED");
    expect(run.parse_diagnostics.map((d) => d.code)).toContain("TEXT_ANSWER");
  });

  it("纯文本只在通用提示词下算成功；九立预设仍报解析错误；像 JSON 但坏掉的仍报错", () => {
    const ctx = { runId: "r", snapshot: null } as never;
    expect(runPipeline({ raw: "这是一段说明", promptKind: "GENERIC_JSON", context: ctx }).status).toBe("SUCCEEDED");
    expect(runPipeline({ raw: "这是一段说明", promptKind: "JIULI_P1", context: ctx }).status).toBe("PARSE_ERROR");
    expect(runPipeline({ raw: '{"a": ', promptKind: "GENERIC_JSON", context: ctx }).status).toBe("PARSE_ERROR");
  });
});
