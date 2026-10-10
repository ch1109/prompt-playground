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
