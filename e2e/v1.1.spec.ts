// v1.1 界面验收：排序后定位（AT-21）、冲突角标（AT-02）、P3 候选池、P4 矩阵、请求预览覆盖与阻断（AT-26）
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    // 这些用例按「提示词调试」的左右分栏操作；只在首次进入时设定，刷新后仍以页面保存的状态为准
    if (!localStorage.getItem("prompt-studio:workspace")) localStorage.setItem("prompt-studio:workspace", JSON.stringify({ state: { workMode: "debug" }, version: 2 }));
  });
});

async function renderFixture(page: Page, prompt: string, fixtureId: string) {
  await page.goto("/projects/jiuli/playground");
  await page.click(`[data-prompt="${prompt}"]`);
  await page.getByRole("button", { name: "示例", exact: true }).click();
  await page.click(`[data-fixture-id="${fixtureId}"]`);
  // 等提示词版本加载完再渲染：版本文本晚到会改动工作区，结果被误标为「来自上次运行」
  await expect(page.getByTestId("header-version")).toBeVisible();
  // 等这次渲染的结果真正读回来（结果页签默认就是选中的，不能只看页签）
  const loaded = page.waitForResponse((r) => /\/api\/runs\/run_[^/?]+$/.test(r.url()) && r.request().method() === "GET");
  await page.click('[data-testid="btn-render"]');
  await loaded;
  await expect(page.getByTestId("tab-visual")).toBeVisible();
}

test("AT-21 表格排序后点击单元格，仍定位到原始 JSON 行", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const table = page.locator('[data-table-id="orderRows"]');
  // 序号降序：第一行变成模型输出的第 3 行
  await table.locator('[data-sort-key="row_no"]').click();
  await table.locator('[data-sort-key="row_no"]').click();
  await table.locator("tbody tr").first().locator('[data-field="model"]').click();
  await expect(page.getByTestId("selection-pointer")).toHaveAttribute("title", "/output/rows/2/values/model");
  await page.getByTestId("selection-pointer").click();
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
  // 召回诊断默认收起，点开才看
  await page.getByText("请求候选池（召回诊断：模型实际收到的全部候选）").click();
  await expect(page.locator('[data-table-id="requestCandidates"] tbody tr')).toHaveCount(6);
});

test("P4 委托行 × 25 字段矩阵：锁定与未核验字段如实显示", async ({ page }) => {
  await renderFixture(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  await page.getByTestId("p4-matrix-details").locator("summary").click();
  const m = page.locator('[data-table-id="fieldMatrix"]');
  await expect(m.getByText(/【锁定】/).first()).toBeVisible();
  await expect(m.getByText(/^本轮未核验/).first()).toBeVisible();
});

test("AT-26 请求预览：显示输入覆盖；模板有未登记变量时明确阻止", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByRole("button", { name: "示例", exact: true }).click();
  await page.click('[data-fixture-id="v3/SC-08/P1"]');
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("input-coverage")).toBeVisible();
  await expect(page.getByTestId("coverage-status")).toHaveText("完整输入");
  // Excel 委托：列出 Sheet 行列；没有 PDF / 图片原件
  await expect(page.getByTestId("input-coverage")).toContainText("Sheet「12-10-2」");
  await expect(page.getByTestId("input-coverage")).toContainText("不涉及图片");
  await page.getByRole("button", { name: /^提示词/ }).click();
  // User 模板默认收起
  await page.getByTestId("user-template").evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await page.getByLabel("User 模板").fill("客户 {{customer_name}}\n{{input_json}}");
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("preview-blockers")).toContainText("UNRESOLVED_TEMPLATE_VARIABLE");
});

test("提示词页的「运行参数」列出能力声明，未声明的如实显示", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  // 模型下拉框和「运行参数」折叠区都在「提示词」页
  await page.getByRole("button", { name: "提示词", exact: true }).click();
  await expect(page.getByLabel("模型", { exact: true })).toBeVisible();
  await page.getByTestId("model-settings").locator("summary").click();
  await expect(page.getByTestId("capability-table")).toContainText("图片输入");
  await expect(page.getByTestId("capability-table")).toContainText("未声明");
});

test("R-01 样本库：搜索与来源筛选，选中后显示详情", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p3"]');
  await page.getByRole("button", { name: "示例", exact: true }).click();
  await page.getByLabel("搜索样本").fill("AT09");
  await expect(page.locator("[data-fixture-id]")).toHaveCount(1);
  await page.getByLabel("搜索样本").fill("");
  await page.getByTestId("btn-fixture-filters").click();
  await page.getByLabel("示例来源").selectOption("RECORDED_MODEL_OUTPUT");
  await expect(page.locator('[data-fixture-id^="constructed/"]')).toHaveCount(0);
  await page.click('[data-fixture-id="v3/SC-08/P3"]');
  await expect(page.getByTestId("fixture-detail")).toContainText("没有标准答案");
  await expect(page.getByTestId("fixture-detail")).toContainText("上游");
});

test("R-06 提示词编辑：搜索计数、行号与变量检查", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p2"]');
  await page.getByRole("button", { name: /^提示词/ }).click();
  const text = ["一、任务", "识别查货事实。", "二、产地", "手写 COD 单独记录。", "印刷 COD 也记录。", "三、输出", "只输出 JSON。"].join("\n");
  await page.getByLabel("System 提示词").fill(text);
  await page.getByLabel("搜索提示词").fill("cod");
  await page.getByLabel("搜索提示词").press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("1/2 处 · 第 4 行");
  await page.getByRole("button", { name: "下一个匹配" }).click();
  await expect(page.getByTestId("search-count")).toHaveText("2/2 处 · 第 5 行");
  await expect(page.getByTestId("cursor-line")).toContainText("第 5 行 / 共 7 行");
  await expect(page.getByTestId("variable-check")).toContainText("变量检查通过");
  await expect(page.getByLabel("System 提示词")).toHaveValue(text);
});

test("R-15 空状态：可打开标明为样本的示例结果", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p4"]');
  // 新浏览器上下文里当前 Prompt 没有打开的 Run
  await page.getByTestId("open-example").click();
  await expect(page.getByTestId("fixture-banner")).toContainText("不是模型本次运行");
});
