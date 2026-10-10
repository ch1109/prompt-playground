// v1.3 界面验收：以「结果检查」为中心的交互重构。不预设工作模式，按新用户首次进入的默认状态操作。
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("prompt-studio-guide-seen", "1"));
});

/** 结果检查模式：通过「更换输入」抽屉选一个示例，选完自动显示结果 */
async function pickInDrawer(page: Page, prompt: string, fixtureId: string) {
  await page.goto("/projects/jiuli/playground");
  await page.click(`[data-prompt="${prompt}"]`);
  await page.getByTestId("btn-change-input").click();
  const drawer = page.getByTestId("input-drawer");
  await drawer.getByRole("button", { name: "示例", exact: true }).click();
  await drawer.locator(`[data-fixture-id="${fixtureId}"]`).click();
  await expect(drawer).toHaveCount(0);
}

test("默认进入「结果检查」：编辑区收起，顶部显示当前输入；更换输入用抽屉，选完自动收起并显示结果", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await expect(page.getByTestId("work-modes").getByRole("tab", { name: "结果检查" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("editor-pane")).toHaveCount(0);
  await page.click('[data-prompt="jiuli-p1"]');
  await expect(page.getByTestId("context-bar")).toContainText("当前输入");
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const bar = page.getByTestId("context-bar");
  await expect(bar).toContainText("P1 冲突");
  await expect(bar).toContainText("人工构造");
  await expect(bar).toContainText("有标准答案");
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  // 再次打开抽屉：已选示例收起成卡片，不再铺开整个列表
  await page.getByTestId("btn-change-input").click();
  await expect(page.getByTestId("input-drawer").getByTestId("fixture-current")).toContainText("P1 冲突");
  await expect(page.getByTestId("input-drawer").locator("[data-fixture-id]")).toHaveCount(0);
  await page.getByTestId("input-drawer").getByLabel("关闭输入抽屉").click();
  // 「编辑提示词」切到提示词调试模式（左右分栏）
  await page.getByTestId("btn-edit-prompt").click();
  await expect(page.getByTestId("editor-pane")).toBeVisible();
  await expect(page.getByTestId("work-modes").getByRole("tab", { name: "提示词调试" })).toHaveAttribute("aria-selected", "true");
});

test("P1 第一屏只有精简状态、商品表、待处理问题；合计与读取情况折叠成一句话", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "v3/2026(DG)ZW001-audit/P1");
  const head = page.getByTestId("result-headline");
  await expect(head).toContainText("示例 / 粘贴结果（未调用模型）");
  await expect(head).toContainText("6 条商品");
  await expect(head).toContainText("准确性未评测");
  // 统计卡片和次要表格默认不展开
  await expect(page.getByTestId("more-stats")).not.toHaveAttribute("open");
  await expect(page.getByText("原始商品行数")).toBeHidden();
  const sec = page.getByTestId("secondary-details");
  await expect(sec).toContainText("合计与读取情况");
  await expect(sec).toContainText("未关联记录 无");
  await expect(page.locator('[data-table-id="readStatus"]')).toBeHidden();
  await sec.locator("summary").click();
  await expect(page.locator('[data-table-id="readStatus"]')).toBeVisible();
  await expect(sec).toContainText("没有记录");
  // 状态用词：运行成功 ≠ 结果正确
  await expect(page.getByTestId("result-pane")).not.toContainText("解析成功");
});

test("商品表：不再有密集的来源绿点；行可展开看全部 25 字段，点字段打开证据并定位到 JSON", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const table = page.locator('[data-table-id="orderRows"]');
  await expect(table.locator('[aria-label="有来源"]')).toHaveCount(0);
  await table.getByTestId("row-expand").first().click();
  const fields = table.getByTestId("row-fields");
  await expect(fields.locator("button")).toHaveCount(26);
  await fields.locator('[data-field="origin"]').click();
  await expect(page.getByTestId("evidence-drawer")).toBeVisible();
  await expect(page.getByTestId("selection-pointer")).toHaveText("/output/rows/0/values/origin");
  // 有冲突的字段排在展开区最前
  await expect(fields.locator("button").first()).toContainText("冲突");
});
