// v1.2：看图默认附带、页数上限可配、文件夹上传、通用提示词。所有模型调用都用本地假服务。
import { describe, expect, it } from "vitest";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { maxPages } from "@/lib/runs/page-images";
import { effectiveAttachImages } from "@/lib/runs/service";

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
