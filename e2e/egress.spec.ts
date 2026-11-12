// 材料外发确认：服务端说「还没确认」→ 弹确认框 → 同意后记录并自动重新发起；不同意什么都不做
// e2e 环境没有真实密钥，所以用路由模拟模型已配置和服务端的回应
import { expect, type Page, test } from "@playwright/test";

const HOST = "gateway.example.com";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (!localStorage.getItem("prompt-studio:workspace")) localStorage.setItem("prompt-studio:workspace", JSON.stringify({ state: { workMode: "debug" }, version: 2 }));
  });
});

/** 打开页面并选好示例；模拟模型已配置；模拟 POST /api/runs（第一次 409，之后 202）和 POST /api/egress，返回两个接口的调用次数 */
async function setup(page: Page, runId: string) {
  const count = { runs: 0, egress: 0 };
  await page.route("**/api/models", (r) => r.fulfill({ json: { ok: true, data: { provider: "openai-compatible@fake", model: "fake", configured: true, supportsFileInput: false, adapterVersion: "1.0.0" }, request_id: "x" } }));
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByRole("button", { name: "示例", exact: true }).click();
  await page.click('[data-fixture-id="v3/SC-08-audit/P1"]');
  await page.route("**/api/runs", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    count.runs++;
    return count.runs === 1
      ? r.fulfill({ status: 409, json: { ok: false, error: { code: "EGRESS_NOT_CONFIRMED", message: `第一次把材料发给 ${HOST}，需要先确认`, details: { provider_host: HOST } }, request_id: "x" } })
      : r.fulfill({ status: 202, json: { ok: true, data: { run_id: runId, status: "RUNNING" }, request_id: "x" } });
  });
  await page.route("**/api/egress", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    count.egress++;
    return r.fulfill({ json: { ok: true, data: { provider_host: HOST, configured: true, confirmed: true, confirmed_at: new Date().toISOString() }, request_id: "x" } });
  });
  return count;
}

async function existingRunId(page: Page): Promise<string> {
  const r = await page.request.post("/api/runs", { data: { mode: "RENDER_ONLY", projectId: "jiuli", promptId: "jiuli-p1", fixtureId: "v3/SC-08-audit/P1" } });
  return (await r.json()).data.run_id;
}

test("第一次外发：确认框写明地址，同意后记录一次并自动重新发起运行", async ({ page }) => {
  const runId = await existingRunId(page);
  const count = await setup(page, runId);
  const messages: string[] = [];
  page.on("dialog", (d) => {
    messages.push(d.message());
    return d.accept();
  });
  await expect(page.getByTestId("header-version")).toBeVisible();
  await page.getByTestId("btn-run").click();
  await expect.poll(() => count.runs).toBe(2);
  expect(count.egress).toBe(1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(`第一次把材料发给 ${HOST}`);
  expect(messages[0]).toContain("以后发往这个地址不再询问");
  await expect(page.getByTestId("error-message")).toHaveCount(0);
});

test("点取消：不记录确认，不重新发起，顶栏也没有红色错误", async ({ page }) => {
  const runId = await existingRunId(page);
  const count = await setup(page, runId);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    return d.dismiss();
  });
  await expect(page.getByTestId("header-version")).toBeVisible();
  await page.getByTestId("btn-run").click();
  await expect.poll(() => dialogs).toBe(1);
  await expect(page.getByTestId("btn-run")).toBeEnabled();
  expect(count.egress).toBe(0);
  expect(count.runs).toBe(1);
  await expect(page.getByTestId("error-message")).toHaveCount(0);
});
