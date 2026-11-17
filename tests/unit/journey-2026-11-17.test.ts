// 2026-11-17 用户旅程验收后的修复：P3/P4 输入由上游运行生成、时间按本地时区显示、
// 过期原因、设为正式、问题标题不露代码、模型设置的密钥提示
import { beforeAll, describe, expect, it } from "vitest";
import { GET as deriveGet, POST as derivePost } from "@/app/api/snapshots/derive/route";
import { POST as stablePost } from "@/app/api/prompts/[id]/stable/route";
import type { Run } from "@/lib/contracts/run";
import { buildInput, usableKinds } from "@/lib/input-builders";
import { p3Request, p4Request } from "@/lib/input-builders/jiuli-chain";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { resetDbForTests } from "@/lib/repositories/db";
import { createVersion, listVersions, stableVersionId } from "@/lib/repositories/prompts";
import { saveRun } from "@/lib/repositories/runs";
import { createSnapshot, getSnapshot } from "@/lib/repositories/snapshots";
import { emptyWorkspace, inputSignature, staleReasons } from "@/lib/state/studio-store";
import { localTime } from "@/lib/time";

const LOCAL = "http://127.0.0.1:3000";
const post = (url: string, b: unknown, headers: Record<string, string> = { origin: LOCAL, host: "127.0.0.1:3000" }) =>
  new Request(`${LOCAL}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const data = async (res: Response) => (await res.json()).data;

// 结构取自 2026-11-17 走查的真实运行（20260206YXW-001），另加一行用来检查 P4 只带实际匹配的原始行
const P1 = {
  v: 15,
  h: { cus: "亿芯微半导体科技（深圳）有限公司", issues: [{ f: "cus", t: "差异", vs: [] }] },
  r: [
    { id: 1, br: "ASOLID", md: "S12_V10", q: "300", u: "个", nw: "57", issues: [] },
    { id: 2, br: "HIROSE", md: "BK22", q: "40", u: "个", issues: [] },
  ],
  g: [{ f: "gw", v: "60", r: [1] }],
  tot: { q: "340", nw: "57", issues: [] },
};
const P2 = {
  v: 15,
  h: [
    {
      wh: "26020161",
      tot: { q: "300", gw: "53", pk: "3" },
      qc: { raw: "300", calc: "300", u: "个" },
      issues: [{ f: "hw", t: "手写记录", vs: [{ s: "第1页表格下方", v: "产地 TW.cn" }] }],
      r: [
        { id: 1, md: "S12_V10", q: "300", u: "个", parts: [{ n: 1, box: "1-2", q: "200" }, { n: 2, box: "3", q: "100" }] },
        { id: 2, md: "OTHER", q: "5", parts: [{ n: 1, q: "5" }] },
      ],
    },
    { wh: "26020999", tot: { gw: "1" }, r: [{ id: 1, md: "BK22", q: "40", parts: [{ n: 1, q: "40" }] }] },
  ],
};
const P3 = {
  r: [
    { id: 1, st: "MATCHED", m: [{ ref: "W-26020161-G1", wh: "26020161", parts: ["P-26020161-1-2"], why: "型号一致" }], c: [], review: false, issues: [] },
    { id: 2, st: "UNMATCHED", m: [], c: [], review: true, issues: [] },
  ],
};

describe("P3 / P4 请求的拼法（与 2026-11-16 测试脚本一致）", () => {
  it("P3：委托商品行 = P1 r[]；查货商品池带稳定引用，原始行也带引用", () => {
    const req = p3Request(P1, P2) as Record<string, unknown>;
    expect(req.委托商品行).toEqual(P1.r);
    expect(req.委托共享值).toEqual(P1.g);
    const pool = req.查货商品池 as Record<string, unknown>[];
    expect(pool.map((x) => x.ref)).toEqual(["W-26020161-G1", "W-26020161-G2", "W-26020999-G1"]);
    expect(pool[0]).toMatchObject({ wh: "26020161", md: "S12_V10", parts: [{ n: 1, ref: "P-26020161-1-1" }, { n: 2, ref: "P-26020161-1-2" }] });
    expect(pool[0]).not.toHaveProperty("id");
    expect(req).toMatchObject({ 已确认关系: [], 人工修订: [] });
  });

  it("P4：只带 P3 实际引用的商品和原始行、对应入仓号的合计与问题、本行相关的共享值", () => {
    const req = p4Request(P1, P2, P1.r[0], P3.r[0]) as Record<string, unknown>;
    expect(req.current).toEqual(P1.r[0]);
    expect(req.委托共享值).toEqual([{ f: "gw", v: "60", r: [1] }]);
    expect(req.委托合计).toEqual(P1.tot);
    expect(req.委托抬头问题).toEqual(P1.h.issues);
    const goods = req.查货匹配商品 as Record<string, unknown>[];
    expect(goods).toHaveLength(1);
    expect((goods[0].parts as { ref: string }[]).map((p) => p.ref)).toEqual(["P-26020161-1-2"]);
    expect((req.查货入仓号范围 as { wh: string }[]).map((s) => s.wh)).toEqual(["26020161"]);
    expect(req.查货入仓号范围).toEqual([{ wh: "26020161", tot: P2.h[0].tot, qc: P2.h[0].qc, g: [], issues: P2.h[0].issues }]);
  });
});

describe("用上游运行生成输入（接口）", () => {
  const run = (id: string, kind: string, parsed: unknown, extra: Partial<Run> = {}) =>
    saveRun({ run_id: id, project_id: "jiuli", prompt_id: `jiuli-${kind.slice(-2).toLowerCase()}`, prompt_kind: kind, mode: "MODEL_RUN", status: "SUCCEEDED", started_at: new Date().toISOString(), label: `${kind} 运行`, model_name: "m", parsed_json: parsed, raw_response: JSON.stringify(parsed), is_unsaved_draft: false, ...extra } as unknown as Run);

  beforeAll(() => {
    resetDbForTests(":memory:");
    run("run_p1", "JIULI_P1", P1);
    run("run_p2", "JIULI_P2", P2);
    run("run_p1_v3", "JIULI_P1", { schema_version: "jiuli-ai-v3", output: {} });
  });

  it("列出可用的 P1 / P2 运行：只要运行成功、输出是 v15 的模型运行", async () => {
    const o = await data(await deriveGet(new Request(`${LOCAL}/api/snapshots/derive?project=jiuli&target=JIULI_P3`)));
    expect(o.p1.map((x: { run_id: string }) => x.run_id)).toEqual(["run_p1"]);
    expect(o.p1[0]).toMatchObject({ label: "JIULI_P1 运行", count: 2 });
    expect(o.p2[0]).toMatchObject({ run_id: "run_p2", count: 3 });
  });

  it("生成 P3 输入：记录来源运行，只用于 P3（和通用提示词）", async () => {
    const res = await derivePost(post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P3", p1RunId: "run_p1", p2RunId: "run_p2" }));
    expect(res.status).toBe(201);
    const [s] = (await data(res)).snapshots;
    const snap = getSnapshot(s.snapshot_id)!;
    expect(snap).toMatchObject({ source_type: "DERIVED", label: "P3 · JIULI_P1 运行 + JIULI_P2 运行", source_ids: { p1_run_id: "run_p1", p2_run_id: "run_p2" } });
    expect(buildInput("JIULI_P3", snap)).toMatchObject({ ok: true, request: p3Request(P1, P2) });
    expect(usableKinds(snap)).toEqual(expect.arrayContaining(["JIULI_P3"]));
    expect(usableKinds(snap)).not.toContain("JIULI_P4");

    // P3 用这份输入运行后，可以为「已匹配」的委托行生成 P4 输入
    run("run_p3", "JIULI_P3", P3, { input_snapshot_id: s.snapshot_id });
    const o = await data(await deriveGet(new Request(`${LOCAL}/api/snapshots/derive?project=jiuli&target=JIULI_P4`)));
    expect(o.p3).toEqual([expect.objectContaining({ run_id: "run_p3", count: 2, matched: 1 })]);
    const p4 = await data(await derivePost(post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P4", p3RunId: "run_p3" })));
    expect(p4.snapshots).toHaveLength(1);
    const s4 = getSnapshot(p4.snapshots[0].snapshot_id)!;
    expect(s4).toMatchObject({ label: "P4 · 委托行 1 · JIULI_P1 运行", source_ids: { p3_run_id: "run_p3", order_row_id: "1" } });
    expect(buildInput("JIULI_P4", s4)).toMatchObject({ ok: true, request: p4Request(P1, P2, P1.r[0], P3.r[0]) });
  });

  it("P3 的输入不是这里生成的：说明没法生成 P4 输入；v3 的 P1 不能用", async () => {
    const pasted = createSnapshot({ project_id: "jiuli", source_type: "JSON_IMPORT", label: "粘贴", data_contract_version: "x", normalized_payload: { request_kind: "JIULI_P3", request: {} } });
    run("run_p3_pasted", "JIULI_P3", P3, { input_snapshot_id: pasted.snapshot_id });
    const r1 = await derivePost(post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P4", p3RunId: "run_p3_pasted" }));
    expect((await r1.json()).error.code).toBe("P3_INPUT_NOT_DERIVED");
    const r2 = await derivePost(post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P3", p1RunId: "run_p1_v3", p2RunId: "run_p2" }));
    expect((await r2.json()).error.code).toBe("UPSTREAM_NOT_V15");
  });
});

describe("设为正式", () => {
  beforeAll(() => resetDbForTests(":memory:"));
  it("只允许本机页面；版本要属于这个提示词；设好后正式版本变了", async () => {
    const before = stableVersionId("jiuli-p1");
    const added = createVersion({ prompt_id: "jiuli-p1", label: "新版本", system_prompt: "S", user_prompt_template: "{{input_json}}" });
    // 保存新版本不会改变正式版本
    expect(stableVersionId("jiuli-p1")).toBe(before);
    const older = added;
    const latest = listVersions("jiuli-p1").find((v) => v.version_id === before)!;
    expect((await stablePost(post("/api/prompts/jiuli-p1/stable", { versionId: older.version_id }, {}), { params: Promise.resolve({ id: "jiuli-p1" }) } as never)).status).toBe(403);
    const other = listVersions("jiuli-p2")[0];
    expect((await stablePost(post("/api/prompts/jiuli-p1/stable", { versionId: other.version_id }), { params: Promise.resolve({ id: "jiuli-p1" }) } as never)).status).toBe(404);
    const ok = await stablePost(post("/api/prompts/jiuli-p1/stable", { versionId: older.version_id }), { params: Promise.resolve({ id: "jiuli-p1" }) } as never);
    expect(ok.status).toBe(200);
    expect(stableVersionId("jiuli-p1")).toBe(older.version_id);
    expect(latest.version_id).not.toBe(older.version_id);
  });
});

describe("界面时间按本机时区", () => {
  it("UTC 02:02 在新加坡显示为 10:02；跨日也按本地日期", () => {
    process.env.TZ = "Asia/Singapore";
    expect(localTime("2026-11-17T02:02:52.841Z")).toBe("2026-11-17 10:02:52");
    expect(localTime("2026-11-16T23:30:00.000Z").slice(5, 16)).toBe("11-17 07:30");
  });
});

describe("结果过期的原因", () => {
  it("分别说出换了输入、改了提示词、改了参数", () => {
    const w = { ...emptyWorkspace(), inputMode: "upload" as const, uploadSnapshotId: "s1", system: "A" };
    const sig = inputSignature(w, "MODEL_RUN");
    expect(staleReasons(w, "MODEL_RUN", sig)).toEqual([]);
    expect(staleReasons({ ...w, uploadSnapshotId: null }, "MODEL_RUN", sig)).toEqual(["input"]);
    expect(staleReasons({ ...w, system: "B" }, "MODEL_RUN", sig)).toEqual(["prompt"]);
    expect(staleReasons({ ...w, model: "other", system: "B" }, "MODEL_RUN", sig)).toEqual(["prompt", "params"]);
  });
});

describe("问题标题不露英文代码", () => {
  it("P2 的 hw（手写记录）只写问题类型；认识的字段写中文名", () => {
    const pr = runPipeline({ raw: JSON.stringify(P2), promptKind: "JIULI_P2", context: { runId: "r" } as never });
    const titles = pr.viewModel!.issues.map((i) => i.summary);
    expect(titles.some((t) => t.includes("hw"))).toBe(false);
    expect(titles.some((t) => t.includes("手写记录"))).toBe(true);
  });
});
