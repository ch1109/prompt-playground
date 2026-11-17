// 2026-11-17 用户旅程验收后的修复：看页签不丢输入、P3/P4 默认打开「用上游结果生成」、设为正式、外发确认在页面内
import { expect, test } from "@playwright/test";

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
