// 提示词「阅读」视图：哪些行显示为标题（只在显示时加 #，原文不改）
import { describe, expect, it } from "vitest";
import { readableMarkdown } from "@/components/playground/prompt-editor";

describe("readableMarkdown", () => {
  it("「一、」章节与【】标题升为标题，行数不变", () => {
    const text = "一、任务\n读取委托书。\n【输出要求】\n只输出 JSON。";
    const md = readableMarkdown(text);
    expect(md.split("\n")).toEqual(["## 一、任务", "读取委托书。", "### 【输出要求】", "只输出 JSON。"]);
  });

  it("单独成行的短小标题（前空行、后有内容、无结尾标点）升为标题", () => {
    expect(readableMarkdown("说明。\n\n通用执行约定\n只输出一个合法 JSON 对象。").split("\n")[2]).toBe("### 通用执行约定");
  });

  it("正文句子、编号条目、紧挨着上一行的短行都不当标题", () => {
    const text = "\n只输出 JSON。\n下一行\n\n1. 客户取明确名称\n不读取\n\n结尾行";
    expect(readableMarkdown(text)).toBe(text);
  });
});
