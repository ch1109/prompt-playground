// 通用提示词的版式：按版式显示结果、调整版式弹窗、AI 生成（接口用路由模拟，不调用真实模型）
import { expect, type Page, test } from "@playwright/test";

const DATA = JSON.stringify([
  { name: "苹果", price: 3, status: "通过" },
  { name: "香蕉", price: 5, status: "不通过" },
]);

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (!localStorage.getItem("prompt-studio:workspace")) localStorage.setItem("prompt-studio:workspace", JSON.stringify({ state: { workMode: "debug" }, version: 2 }));
  });
});

/** 新建项目 + 通用提示词，粘贴 JSON 并「仅渲染」，停在结果页 */
async function setup(page: Page, raw: string) {
  const project = await page.request.post("/api/projects", { data: { name: `版式 ${Date.now()}-${Math.random()}`, template: "BLANK" } }).then((r) => r.json());
  const pid: string = project.data.project_id;
  const prompt = await page.request.post("/api/prompts", { data: { projectId: pid, name: "通用", kind: "GENERIC_JSON" } }).then((r) => r.json());
  await page.goto(`/projects/${pid}/playground`);
  await page.locator(`[data-prompt="${prompt.data.prompt_id}"]`).click();
  await page.getByRole("button", { name: "粘贴 JSON", exact: true }).click();
  await page.getByLabel("原始输出", { exact: true }).fill(raw);
  await page.click('[data-testid="btn-render"]');
  await expect(page.getByTestId("result-json")).toBeVisible();
}

test("没有版式时生成版式：用自动推导的表格起点，改列名后保存，结果按表格显示", async ({ page }) => {
  await setup(page, DATA);
  await page.getByTestId("layout-generate").click();
  const dialog = page.getByTestId("layout-editor");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("lk-table").check();
  await expect(dialog.getByTestId("le-preview").locator('[data-testid="layout-view"][data-kind="table"]')).toBeVisible();
  await dialog.getByLabel("列1的显示名").fill("水果名称");
  await dialog.getByTestId("le-save").click();
  await expect(dialog).toHaveCount(0);
  const view = page.getByTestId("layout-view");
  await expect(view).toHaveAttribute("data-kind", "table");
  await expect(view).toContainText("水果名称");
  await expect(view).toContainText("香蕉");
  await expect(page.getByTestId("result-json")).toHaveCount(0);
  await page.getByTestId("layout-toggle-tree").click();
  await expect(page.getByTestId("result-json")).toBeVisible();
});

test("点「让 AI 生成」：采用返回的卡片版式，保存后按卡片显示", async ({ page }) => {
  await page.route("**/api/prompts/*/layout/generate", (r) =>
    r.fulfill({ json: { ok: true, data: { layout: { version: 1, kind: "cards", itemsPath: "", titlePath: "/name", fields: [{ label: "单价", path: "/price" }] } }, request_id: "x" } }),
  );
  await setup(page, DATA);
  await page.getByTestId("layout-generate").click();
  const dialog = page.getByTestId("layout-editor");
  await dialog.getByTestId("le-generate").click();
  await expect(dialog.getByTestId("lk-cards")).toBeChecked();
  await expect(dialog.getByTestId("le-preview")).toContainText("单价");
  await dialog.getByTestId("le-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("layout-view")).toHaveAttribute("data-kind", "cards");
  await expect(page.getByTestId("layout-view")).toContainText("苹果");
});

test("AI 生成失败时显示中文原因，弹窗不关闭", async ({ page }) => {
  await page.route("**/api/prompts/*/layout/generate", (r) => r.fulfill({ status: 502, json: { ok: false, error: { code: "LAYOUT_GENERATE_FAILED", message: "模型没有给出可用的版式" }, request_id: "x" } }));
  await setup(page, DATA);
  await page.getByTestId("layout-generate").click();
  const dialog = page.getByTestId("layout-editor");
  await dialog.getByTestId("le-generate").click();
  await expect(dialog.getByTestId("le-error")).toContainText("模型没有给出可用的版式");
  await expect(dialog).toBeVisible();
});

test("版式和这次输出对不上时，提示之后仍显示 JSON 树", async ({ page }) => {
  await setup(page, DATA);
  await page.getByTestId("layout-generate").click();
  const dialog = page.getByTestId("layout-editor");
  await dialog.getByTestId("lk-table").check();
  await dialog.getByTestId("le-save").click();
  await expect(dialog).toHaveCount(0);
  // 换一份结构不同的输出：已保存的表格版式找不到数组
  await page.getByRole("button", { name: "粘贴 JSON", exact: true }).click();
  await page.getByLabel("原始输出", { exact: true }).fill('{"summary":"ok"}');
  await page.click('[data-testid="btn-render"]');
  await expect(page.getByTestId("layout-view")).toHaveAttribute("data-kind", "mismatch");
  await expect(page.getByTestId("result-json").locator('[data-pointer="/summary"]')).toBeVisible();
});

test("样例有两个列表时可在弹窗里换「数据」位置，预览跟着变", async ({ page }) => {
  await setup(page, JSON.stringify({ fruits: [{ name: "苹果", price: 3 }], veggies: [{ title: "白菜", weight: 9 }] }));
  await page.getByTestId("layout-generate").click();
  const dialog = page.getByTestId("layout-editor");
  await dialog.getByTestId("lk-table").check();
  const preview = dialog.getByTestId("le-preview");
  await expect(preview).toContainText("苹果");
  await dialog.getByTestId("le-items").selectOption("/veggies");
  await expect(preview).toContainText("白菜");
  await expect(preview).not.toContainText("苹果");
  await expect(dialog.getByTestId("le-rederived")).toBeVisible();
});

test("样例只有一个列表时不显示「数据」选择", async ({ page }) => {
  await setup(page, DATA);
  await page.getByTestId("layout-generate").click();
  await expect(page.getByTestId("layout-editor")).toBeVisible();
  await expect(page.getByTestId("le-items")).toHaveCount(0);
});
