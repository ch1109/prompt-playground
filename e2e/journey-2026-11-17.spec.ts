// 2026-11-17 用户旅程验收后的修复：看页签不丢输入、P3/P4 默认打开「用上游结果生成」、设为正式、P4 全部运行
import { expect, test } from "@playwright/test";

// 最小的 v15 上游结果：两条委托行都能在查货里找到，P3 判两行都「已匹配」→ 生成 2 份 P4 输入
const P1 = { v: 15, h: {}, r: [{ id: 1, md: "S12_V10", q: "300" }, { id: 2, md: "BK22", q: "40" }], g: [], tot: {} };
const P2 = {
  v: 15,
  h: [
    { wh: "26020161", r: [{ id: 1, md: "S12_V10", q: "300", parts: [{ n: 1, q: "300" }] }] },
    { wh: "26020999", r: [{ id: 1, md: "BK22", q: "40", parts: [{ n: 1, q: "40" }] }] },
  ],
};
const P3 = {
  r: [
    { id: 1, st: "MATCHED", m: [{ ref: "W-26020161-G1", wh: "26020161", parts: ["P-26020161-1-1"] }], c: [], review: false, issues: [] },
    { id: 2, st: "MATCHED", m: [{ ref: "W-26020999-G1", wh: "26020999", parts: ["P-26020999-1-1"] }], c: [], review: false, issues: [] },
  ],
};

test("更换输入：只是切页签看一眼，当前输入不变；真正选了才换", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByTestId("btn-change-input").click();
  const drawer = page.getByTestId("input-drawer");
  await drawer.getByRole("button", { name: "示例", exact: true }).click();
  await drawer.locator('[data-fixture-id="constructed/p1-v3-conflict.json"]').click();
  await expect(drawer).toHaveCount(0);
  const bar = page.getByTestId("context-bar");
  await expect(bar).toContainText("P1 冲突");

  await page.getByTestId("btn-change-input").click();
  for (const tab of ["上传文件", "历史输入"]) await drawer.getByRole("button", { name: tab, exact: true }).click();
  for (const more of ["粘贴 JSON", "从九立导入"]) await drawer.getByRole("button", { name: more, exact: true }).click();
  await drawer.getByLabel("关闭输入抽屉").click();
  await expect(bar).toContainText("P1 冲突");
  await expect(page.getByTestId("btn-render")).toBeEnabled();
  await expect(page.getByTestId("stale-banner")).toHaveCount(0);
});

test("P3 / P4 的更换输入默认打开「用上游结果生成」；没有可用运行时说清楚先做什么", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p3"]');
  await page.getByTestId("btn-change-input").click();
  const drawer = page.getByTestId("input-drawer");
  await expect(drawer.getByRole("button", { name: "用 P1+P2 生成" })).toBeVisible();
  await expect(drawer.getByTestId("derive-input")).toContainText("还没有可用的 P1 运行结果");
  await drawer.getByLabel("关闭输入抽屉").click();

  await page.click('[data-prompt="jiuli-p4"]');
  await page.getByTestId("btn-change-input").click();
  await expect(drawer.getByTestId("derive-input")).toContainText("还没有可用的 P3 运行结果");
});

test("设为正式：在提示词页把当前版本设为正式，下拉里的【正式】跟着变", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p2"]');
  await page.getByTestId("work-modes").getByRole("tab", { name: "提示词调试" }).click();
  await page.getByTestId("editor-pane").getByRole("button", { name: "提示词", exact: true }).click();
  const select = page.getByLabel("Prompt 版本");
  // 先存一个新版本：保存不会改变正式版本，所以出现「设为正式」
  await page.getByLabel("System 提示词").fill(`走查 ${Date.now()}`);
  await page.getByLabel("新版本名称").fill("e2e 设为正式");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(select.locator("option:checked")).toContainText("e2e 设为正式");
  await expect(select.locator("option:checked")).not.toContainText("【正式】");
  await page.getByTestId("btn-set-stable").click();
  await expect(select.locator("option:checked")).toContainText("【正式】");
  await expect(page.getByTestId("btn-set-stable")).toHaveCount(0);
});

test("P4 全部运行：同一次 P3 生成的几份输入一起发出，结果区打开当前选中的那一份", async ({ page, request }) => {
  // e2e 没有真实模型：用「仅渲染」造出 P1、P2、P3 记录，用生成接口得到 2 份 P4 输入；只拦截「发起运行」，记下发了哪些输入
  const post = async (url: string, data: unknown) => (await (await request.post(url, { data })).json()).data;
  const render = async (promptId: string, raw: unknown, snapshotId?: string): Promise<string> =>
    (await post("/api/runs", { mode: "RENDER_ONLY", projectId: "jiuli", promptId, raw: JSON.stringify(raw), snapshotId })).run_id;
  const p1RunId = await render("jiuli-p1", P1);
  const p2RunId = await render("jiuli-p2", P2);
  const [p3Input] = (await post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P3", p1RunId, p2RunId })).snapshots;
  const p3RunId = await render("jiuli-p3", P3, p3Input.snapshot_id);
  const p4Inputs: { snapshot_id: string }[] = (await post("/api/snapshots/derive", { projectId: "jiuli", target: "JIULI_P4", p3RunId })).snapshots;
  expect(p4Inputs).toHaveLength(2);
  const p4RunId = await render("jiuli-p4", {}, p4Inputs[1].snapshot_id);

  const sent: string[] = [];
  await page.route("**/api/models", (r) => r.fulfill({ json: { ok: true, data: { provider: "openai-compatible@fake", model: "fake", configured: true, supportsFileInput: false, adapterVersion: "1.0.0" }, request_id: "x" } }));
  await page.route("**/api/runs", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    sent.push(r.request().postDataJSON().snapshotId);
    return r.fulfill({ status: 202, json: { ok: true, data: { run_id: p4RunId, status: "RUNNING" }, request_id: "x" } });
  });
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p4"]');
  await page.getByTestId("btn-change-input").click();
  const drawer = page.getByTestId("input-drawer");
  await drawer.getByRole("button", { name: "历史输入", exact: true }).click();
  await drawer.locator(`[data-snapshot-id="${p4Inputs[1].snapshot_id}"]`).click();

  const all = page.getByTestId("btn-run-all");
  await expect(all).toHaveText("全部运行（2 份）");
  await all.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]).toBe(p4Inputs[1].snapshot_id);
  expect(sent.toSorted()).toEqual(p4Inputs.map((x) => x.snapshot_id).toSorted());
  await expect(page.getByTestId("error-message")).toHaveCount(0);

  // 别的提示词没有这个按钮
  await page.click('[data-prompt="jiuli-p1"]');
  await expect(all).toHaveCount(0);
});
