// 材料外发确认与记录：服务端强制确认、确认记录只新增、每次运行留痕、来源校验、导出
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as egressGet, POST as egressPost } from "@/app/api/egress/route";
import { POST as runsPost } from "@/app/api/runs/route";
import { POST as retryPost } from "@/app/api/runs/[id]/retry/route";
import { createCandidate, startExperiment } from "@/lib/experiments/service";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { getEgressConsent, hasEgressConsent, recordEgressConsent } from "@/lib/repositories/egress";
import { listVersions } from "@/lib/repositories/prompts";
import { getRun } from "@/lib/repositories/runs";
import { loadRunContext, runManifest } from "@/lib/runs/debug-bundle";
import { contextMarkdown } from "@/lib/runs/export";
import { egressKinds, renderOnly } from "@/lib/runs/service";

const FIXTURE = "v3/SC-08/P1";
const LOCAL = "http://127.0.0.1:3000";
const RAW = getFixture(FIXTURE)!.raw;
let calls = 0;
let snapshotId = "";

function provider(host = "model.invalid", key = "sk-test-egress") {
  return new OpenAICompatibleProvider(
    { baseUrl: `https://${host}/v1`, model: "fake-model", apiKey: key, timeoutMs: 2000 },
    (async () => {
      calls++;
      return Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: RAW }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }) as unknown as typeof fetch,
  );
}
const base = () => listVersions("jiuli-p1").find((v) => v.label.startsWith("v3.0 原文"))!;
const runBody = () => ({ mode: "MODEL_RUN", projectId: "jiuli", promptId: "jiuli-p1", snapshotId, system: base().system_prompt, userTemplate: base().user_prompt_template, params: {} });
const post = (url: string, b: unknown, headers: Record<string, string> = { origin: LOCAL, host: "127.0.0.1:3000" }) =>
  new Request(`${LOCAL}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const runCount = () => (db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
async function waitRun(id: string) {
  for (let i = 0; i < 100 && getRun(id)!.status === "RUNNING"; i++) await new Promise((r) => setTimeout(r, 20));
  return getRun(id)!;
}

beforeAll(() => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-egress-mat-"));
  snapshotId = snapshotForFixture("jiuli", getFixture(FIXTURE)!)!.snapshot_id;
});
afterEach(() => {
  setProviderForTests(undefined);
  calls = 0;
});

describe("服务端强制确认", () => {
  it("未确认：409 EGRESS_NOT_CONFIRMED，带 host；没有创建 Run，服务商没被调用", async () => {
    setProviderForTests(provider());
    const before = runCount();
    const res = await runsPost(post("/api/runs", runBody()));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatchObject({ code: "EGRESS_NOT_CONFIRMED", message: "第一次把材料发给 model.invalid，需要先确认", details: { provider_host: "model.invalid" } });
    expect(runCount()).toBe(before);
    expect(calls).toBe(0);
  });

  it("确认后同样的请求成功；Run 里有外发记录（host、kinds、授权人、确认时间）", async () => {
    setProviderForTests(provider());
    const c = await egressPost(post("/api/egress", { project_id: "jiuli", provider_host: "model.invalid" }));
    expect(c.status).toBe(200);
    const res = await runsPost(post("/api/runs", runBody()));
    expect(res.status).toBe(202);
    const run = await waitRun((await res.json()).data.run_id);
    expect(calls).toBe(1);
    expect(run.egress).toEqual({ provider_host: "model.invalid", kinds: ["text"], authorized_by: "web:本机用户", consent_at: getEgressConsent("jiuli", "model.invalid")!.confirmed_at });
    expect(runManifest(loadRunContext(run.run_id)!).model.egress).toEqual(run.egress);
    // 原样重试同样需要且已满足确认
    const retry = await retryPost(new Request(`${LOCAL}/api/runs/${run.run_id}/retry`, { method: "POST" }) as never, { params: Promise.resolve({ id: run.run_id }) } as never);
    expect(retry.status).toBe(202);
    await waitRun((await retry.json()).data.run_id);
  });

  it("换了服务商地址又需要确认；原样重试同理", async () => {
    setProviderForTests(provider("other.invalid"));
    const res = await runsPost(post("/api/runs", runBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.provider_host).toBe("other.invalid");
    const prev = (db().prepare("SELECT run_id FROM runs WHERE mode = 'MODEL_RUN' ORDER BY started_at DESC LIMIT 1").get() as { run_id: string }).run_id;
    const retry = await retryPost(new Request(`${LOCAL}/api/runs/${prev}/retry`, { method: "POST" }) as never, { params: Promise.resolve({ id: prev }) } as never);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("EGRESS_NOT_CONFIRMED");
  });

  it("模型未配置：保持原来的报错，不先报外发未确认", async () => {
    setProviderForTests(provider("third.invalid", ""));
    const res = await runsPost(post("/api/runs", runBody()));
    expect((await res.json()).error.code).toBe("MODEL_NOT_CONFIGURED");
  });

  it("仅渲染不需要确认", async () => {
    setProviderForTests(provider("fourth.invalid"));
    const res = await runsPost(post("/api/runs", { mode: "RENDER_ONLY", projectId: "jiuli", promptId: "jiuli-p1", raw: RAW }));
    expect(res.status).toBe(201);
    expect(renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: RAW }).egress).toBeUndefined();
  });
});

describe("确认记录与确认接口", () => {
  it("确认记录不可改、不可删；重复确认不报错也不改原记录", () => {
    const first = recordEgressConsent("jiuli", "once.invalid", "甲");
    expect(recordEgressConsent("jiuli", "once.invalid", "乙")).toEqual(first);
    expect(hasEgressConsent("jiuli", "once.invalid")).toBe(true);
    expect(db().prepare("SELECT COUNT(*) AS n FROM egress_consents WHERE provider_host = 'once.invalid'").get()).toEqual({ n: 1 });
    expect(() => db().prepare("UPDATE egress_consents SET confirmed_by = 'x'").run()).toThrow(/只新增/);
    expect(() => db().prepare("DELETE FROM egress_consents").run()).toThrow(/只新增/);
  });

  it("GET 返回当前地址与是否已确认", async () => {
    setProviderForTests(provider("model.invalid"));
    expect((await (await egressGet(new Request(`${LOCAL}/api/egress?project=jiuli`))).json()).data).toMatchObject({ provider_host: "model.invalid", configured: true, confirmed: true });
    setProviderForTests(provider("fresh.invalid"));
    expect((await (await egressGet(new Request(`${LOCAL}/api/egress?project=jiuli`))).json()).data).toMatchObject({ provider_host: "fresh.invalid", confirmed: false, confirmed_at: null });
  });

  it("POST 来源校验、host 必须与当前一致、项目必须存在", async () => {
    setProviderForTests(provider("fresh.invalid"));
    const body = { project_id: "jiuli", provider_host: "fresh.invalid" };
    expect((await egressPost(post("/api/egress", body, { origin: "https://evil.example", host: "127.0.0.1:3000" }))).status).toBe(403);
    expect((await egressPost(post("/api/egress", body, { host: "127.0.0.1:3000" }))).status).toBe(403);
    expect((await egressPost(post("/api/egress", { ...body, provider_host: "elsewhere.invalid" }))).status).toBe(409);
    expect((await egressPost(post("/api/egress", { ...body, project_id: "nope" }))).status).toBe(404);
    expect(hasEgressConsent("jiuli", "fresh.invalid")).toBe(false);
    expect((await egressPost(post("/api/egress", body))).status).toBe(200);
    expect(hasEgressConsent("jiuli", "fresh.invalid")).toBe(true);
  });
});

describe("留痕与导出", () => {
  it("kinds：文字一定有，附带图片再加图片", () => {
    expect(egressKinds(0)).toEqual(["text"]);
    expect(egressKinds(3)).toEqual(["text", "image"]);
  });

  it("导出的 context.md 有外发一行；没有记录写「未记录」", async () => {
    setProviderForTests(provider("model.invalid"));
    const res = await runsPost(post("/api/runs", runBody()));
    const run = await waitRun((await res.json()).data.run_id);
    const ctx = loadRunContext(run.run_id)!;
    expect(contextMarkdown(ctx, [])).toContain("- 外发：发往 model.invalid · 文字 · 由 本机用户 授权");
    // 旧 Run（没有 egress 字段）
    expect(contextMarkdown({ ...ctx, run: { ...ctx.run, egress: undefined } }, [])).toContain("- 外发：未记录");
  });

  it("试运行（实验）不查确认表；Run 记 agent:<principal>，确认时间为空", async () => {
    setProviderForTests(provider("agent.invalid"));
    const b = base();
    const { candidate } = createCandidate({ promptId: "jiuli-p1", baseVersionId: b.version_id, system: `${b.system_prompt}\n（试运行）`, userTemplate: b.user_prompt_template, reason: "测试", createdBy: "test-agent" });
    const exp = await startExperiment({ candidateId: candidate.candidate_id, samples: [{ sample_id: FIXTURE, role: "TARGET" }], maxModelRuns: 4, createdBy: "claude-code" }).done;
    expect(exp.status).toBe("COMPLETED");
    expect(hasEgressConsent("jiuli", "agent.invalid")).toBe(false);
    const ids = exp.samples.flatMap((s) => [s.baseline_run_id, s.candidate_run_id]).filter((x): x is string => !!x);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(getRun(id)!.egress).toMatchObject({ provider_host: "agent.invalid", authorized_by: "agent:claude-code", consent_at: null });
  });
});
