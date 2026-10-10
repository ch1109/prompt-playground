// v1.1 界面验收：排序后定位（AT-21）、冲突角标（AT-02）、P3 候选池、P4 矩阵、请求预览覆盖与阻断（AT-26）
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("prompt-studio-guide-seen", "1"));
});

async function renderFixture(page: Page, prompt: string, fixtureId: string) {
  await page.goto("/projects/jiuli/playground");
  await page.click(`[data-prompt="${prompt}"]`);
  await page.click(`[data-fixture-id="${fixtureId}"]`);
  await page.click('[data-testid="btn-render"]');
  await expect(page.getByTestId("tab-visual")).toBeVisible();
}

test("AT-21 表格排序后点击单元格，仍定位到原始 JSON 行", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const table = page.locator('[data-table-id="orderRows"]');
  // 序号降序：第一行变成模型输出的第 3 行
  await table.locator('[data-sort-key="row_no"]').click();
  await table.locator('[data-sort-key="row_no"]').click();
  await table.locator("tbody tr").first().locator('[data-field="model"]').click();
  await expect(page.getByTestId("selection-pointer")).toHaveText("/output/rows/2/values/model");
  await page.getByTestId("btn-view-json").click();
  await expect(page.getByTestId("tab-json")).toBeVisible();
});

test("AT-02 冲突字段在「核心字段」下也显示，并带冲突角标", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const table = page.locator('[data-table-id="orderRows"]');
  await expect(table.locator('[data-field="customs_unit_price"] [data-testid="cell-issue"]')).toHaveText("冲突");
  await table.getByLabel(/只看有问题的行/).check();
  await expect(table.locator("tbody tr")).toHaveCount(2);
});

test("P3 请求候选池列出模型收到的全部候选", async ({ page }) => {
  await renderFixture(page, "jiuli-p3", "constructed/p3-v3-multi-candidate.json");
  await expect(page.getByText("请求候选池（召回诊断：模型实际收到的全部候选）")).toBeVisible();
  await expect(page.locator('[data-table-id="requestCandidates"] tbody tr')).toHaveCount(6);
});

test("P4 委托行 × 25 字段矩阵：锁定与未核验字段如实显示", async ({ page }) => {
  await renderFixture(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  const m = page.locator('[data-table-id="fieldMatrix"]');
  await expect(m.getByText(/【锁定】/).first()).toBeVisible();
  await expect(m.getByText(/^本轮未核验/).first()).toBeVisible();
});

test("AT-26 请求预览：显示输入覆盖；模板有未登记变量时明确阻止", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.click('[data-fixture-id="v3/SC-08/P1"]');
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("input-coverage")).toBeVisible();
  await expect(page.getByTestId("coverage-status")).toHaveText("完整输入");
  // Excel 委托：列出 Sheet 行列；没有 PDF / 图片原件
  await expect(page.getByTestId("input-coverage")).toContainText("Sheet「12-10-2」");
  await expect(page.getByTestId("input-coverage")).toContainText("不涉及图片");
  await page.getByRole("button", { name: /^提示词/ }).click();
  await page.getByLabel("User 模板").fill("客户 {{customer_name}}\n{{input_json}}");
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("preview-blockers")).toContainText("UNRESOLVED_TEMPLATE_VARIABLE");
});

test("模型页列出能力声明，未声明的如实显示", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByTestId("capability-table")).toContainText("图片输入");
  await expect(page.getByTestId("capability-table")).toContainText("未声明");
});
