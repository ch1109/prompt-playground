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

test("检查动作：选中字段可一键标「这个值对」，模型原始输出不变；可只看有问题的行", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const currentRun = () => page.evaluate(() => JSON.parse(localStorage.getItem("prompt-studio:workspace") ?? "{}").state?.workspaces?.["jiuli-p1"]?.runId ?? null);
  await expect.poll(currentRun).not.toBeNull();
  const runId: string = await currentRun();
  const before = await page.request.get(`/api/runs/${runId}`).then((r) => r.json());
  const table = page.locator('[data-table-id="orderRows"]');
  await table.locator("tbody tr").first().locator('[data-field="model"]').click();
  const verdict = page.getByTestId("field-verdict");
  await expect(verdict).toContainText("型号");
  await verdict.getByTestId("btn-mark-correct").click();
  await expect(verdict.getByTestId("btn-mark-correct")).toHaveText("✓ 已标为正确");
  await expect(page.getByTestId("evidence-drawer")).toContainText("标注正确");
  const after = await page.request.get(`/api/runs/${runId}`).then((r) => r.json());
  expect(after.data.run.raw_response_hash).toBe(before.data.run.raw_response_hash);
  expect(after.data.annotations.some((a: { assessment: string }) => a.assessment === "CORRECT")).toBe(true);
  // 「这个值错」跳到完整标注表单（必须选错误归因）
  await verdict.getByTestId("btn-mark-wrong").click();
  await expect(page.getByLabel("错误归因")).toBeFocused();
  // 精简状态里的「只看有问题的行」
  const rows = await table.locator("tbody tr").count();
  await page.getByTestId("btn-only-issues").click();
  await expect(table.locator("tbody tr")).not.toHaveCount(rows);
  await page.getByTestId("btn-only-issues").click();
  await expect(table.locator("tbody tr")).toHaveCount(rows);
});

test("版本对比模式：在页面里勾选两次运行，直接显示对比，不弹窗", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  await page.getByTestId("btn-change-input").click();
  await page.getByTestId("input-drawer").getByTestId("btn-change-fixture").click();
  await page.getByTestId("input-drawer").locator('[data-fixture-id="constructed/p1-v3-xss.json"]').click();
  await expect(page.getByTestId("context-bar")).toContainText("恶意 HTML");
  await page.getByTestId("headline-actions").getByRole("button", { name: "对比历史运行" }).click();
  const mode = page.getByTestId("compare-mode");
  await expect(mode).toBeVisible();
  const boxes = mode.getByRole("checkbox");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const region = page.getByRole("region", { name: "对比两次运行" });
  await expect(region.getByTestId("compare-metrics")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "对比两次运行" })).toHaveCount(0);
});

test("M1 状态用词：问题数按来源拆分；P2~P4 也显示准确性未评测；仅渲染不说「模型运行成功」；P2 合计与覆盖范围默认折叠", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const head = page.getByTestId("result-headline");
  await expect(head).toContainText("3 条模型报告问题");
  await expect(head).toContainText("1 条规则 / 结构提示");
  await expect(page.getByTestId("result-pane")).toContainText("已整理（未调用模型）");
  await expect(page.getByTestId("result-pane")).not.toContainText("模型运行成功");
  for (const [prompt, fixture] of [
    ["jiuli-p2", "v3/SC-08/P2"],
    ["jiuli-p3", "v3/SC-08/P3"],
    ["jiuli-p4", "v3/SC-08/P4"],
  ]) {
    await pickInDrawer(page, prompt, fixture);
    await expect(head).toContainText("条模型报告问题");
    await expect(head).toContainText("准确性未评测");
  }
  await pickInDrawer(page, "jiuli-p2", "v3/SC-08/P2");
  const scope = page.getByTestId("p2-scope-details");
  await expect(scope).toContainText("合计与覆盖范围");
  await expect(scope).not.toHaveAttribute("open");
  await expect(scope.locator("summary")).not.toContainText("scope_records");
});

test("M1 运行证据：详情顶部显示采集完整度与诊断状态；输出结构版本与提示词登记的不一致时给出警告", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await page.getByRole("tab", { name: "详情" }).click();
  const ev = page.getByTestId("run-evidence");
  await expect(ev.getByTestId("capture-quality")).toContainText("未调用模型，不适用");
  await expect(ev.locator('[data-state="EVAL_NOT_AVAILABLE"]')).toBeVisible();
  await expect(page.getByTestId("schema-version-mismatch")).toHaveCount(0);
  // P1 提示词登记的是 jiuli-ai-v3，这个格式示例声明的是 jiuli-ai-v2
  await pickInDrawer(page, "jiuli-p1", "v2/p1-original-output-example.json");
  await expect(page.getByTestId("schema-version-mismatch")).toContainText("jiuli-ai-v3");
});

test("M1 验收：P1~P4 各选一个字段，不离开结果页即可看字段状态、实际输入、来源并标注错误；刷新后标注仍在", async ({ page }) => {
  const cases = [
    { prompt: "jiuli-p1", fixture: "v3/SC-08/P1", table: "orderRows", row: "row-1", field: "brand" },
    { prompt: "jiuli-p2", fixture: "v3/SC-08/P2", table: "inspectionRawRows", row: "rec-1", field: "brand" },
    { prompt: "jiuli-p3", fixture: "constructed/p3-v3-multi-candidate.json", table: "orderRows", row: "OR_001", field: "match_status" },
    { prompt: "jiuli-p4", fixture: "constructed/p4-v3-conflict.json", table: "fieldDecisions", row: "OR_001:brand", field: "result_value" },
  ];
  for (const c of cases) {
    await pickInDrawer(page, c.prompt, c.fixture);
    await page.locator(`[data-table-id="${c.table}"] [data-row-id="${c.row}"] [data-field="${c.field}"]`).first().click();
    const verdict = page.getByTestId("field-verdict");
    await expect(verdict.getByTestId("field-state")).not.toBeEmpty();
    // 仅渲染没有模型输入记录：如实说明，不假装已发送
    await expect(verdict.getByTestId("field-input-coverage")).toContainText(/没有调用模型|不可追溯|请求数据/);
    await expect(page.getByTestId("result-pane").getByRole("tab", { name: "结果" })).toHaveAttribute("aria-selected", "true");
    await verdict.getByTestId("btn-mark-wrong").click();
    await page.getByLabel("错误归因").selectOption("UNKNOWN");
    await page.getByLabel("正确值").fill(`期望-${c.prompt}`);
    await page.getByRole("button", { name: "保存标注" }).click();
    await expect(page.getByTestId("annotation-form")).toContainText(`正确值：期望-${c.prompt}`);
    // 刷新页面：回到同一条结果，标注仍在
    await page.reload();
    await page.locator(`[data-table-id="${c.table}"] [data-row-id="${c.row}"] [data-field="${c.field}"]`).first().click();
    await expect(page.getByTestId("annotation-form")).toContainText(`正确值：期望-${c.prompt}`);
  }
});

test("M1 样本抽屉：每个示例显示运行次数与标错数；可按「只能仅渲染」「只看运行过的」筛选", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  await page.getByTestId("btn-change-input").click();
  const drawer = page.getByTestId("input-drawer");
  await expect(drawer.getByTestId("fixture-summary")).toContainText(/运行 \d+ 次/);
  await drawer.getByTestId("btn-change-fixture").click();
  const list = drawer.getByTestId("fixture-list");
  await expect(list.locator('[data-fixture-id="constructed/p4-v3-conflict.json"]').getByTestId("fixture-stats")).toContainText(/运行 [1-9]/);
  await list.getByLabel("能否真实运行").selectOption("render");
  await expect(list.locator('[data-fixture-id="constructed/p4-v3-conflict.json"]')).toHaveCount(0);
  await list.getByLabel("能否真实运行").selectOption("");
  await list.getByLabel("只看运行过的").check();
  await expect(list.locator('[data-fixture-id="constructed/p4-v3-conflict.json"]')).toBeVisible();
  for (const stats of await list.getByTestId("fixture-stats").allTextContents()) expect(stats).not.toMatch(/运行 0/);
});
