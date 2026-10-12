// v1.3 M3：正式版本、隔离候选、实验与评判、审批。真实模型与 Agent 的验收见 docs/audit/v1.3-gap-matrix.md。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setProviderForTests } from "@/lib/models/openai-compatible";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { createVersion, listVersions, stableHistory, stableVersionId } from "@/lib/repositories/prompts";

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-m3-mat-"));
});
afterEach(() => setProviderForTests(undefined));

describe("M3 正式版本", () => {
  it("首次读取时取当时最新版本为正式版本并留记录；之后保存新版本不改变正式版本", () => {
    const latest = listVersions("jiuli-p1")[0];
    expect(stableVersionId("jiuli-p1")).toBe(latest.version_id);
    expect(stableHistory("jiuli-p1")).toEqual([expect.objectContaining({ version_id: latest.version_id, previous_version_id: null, decided_by: "system" })]);
    const v = createVersion({ prompt_id: "jiuli-p1", label: "我的草稿", system_prompt: "S2", user_prompt_template: "{{input_json}}" });
    expect(listVersions("jiuli-p1")[0].version_id).toBe(v.version_id);
    expect(stableVersionId("jiuli-p1")).toBe(latest.version_id);
    expect(stableHistory("jiuli-p1")).toHaveLength(1);
  });

  it("正式版本变更记录只能追加", () => {
    expect(() => db().prepare("UPDATE prompt_stable_history SET note = 'x'").run()).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM prompt_stable_history").run()).toThrow(/只追加/);
  });
});
