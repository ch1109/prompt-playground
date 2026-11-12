import { describe, expect, it } from "vitest";
import { stateLabel } from "@/lib/adapters/helpers";

describe("状态格子中文显示", () => {
  it("有映射的英文枚举显示中文，英文留作提示", () => {
    expect(stateLabel("MULTIPLE_CANDIDATES")).toEqual({ code: "MULTIPLE_CANDIDATES", label: "多个候选" });
    expect(stateLabel("PARTIAL")).toEqual({ code: "PARTIAL", label: "部分覆盖" });
  });
  it("「英文（中文）」旧形式能拆开", () => {
    expect(stateLabel("KEEP（保持）")).toEqual({ code: "KEEP", label: "保持" });
    expect(stateLabel("NO_EVIDENCE（未取得证据）")).toEqual({ code: "NO_EVIDENCE", label: "未取得证据" });
  });
  it("未知值原样返回，不吞掉", () => {
    expect(stateLabel("PROBABLY_MATCHED")).toEqual({ code: "", label: "PROBABLY_MATCHED" });
    expect(stateLabel("选中")).toEqual({ code: "", label: "选中" });
  });
});
