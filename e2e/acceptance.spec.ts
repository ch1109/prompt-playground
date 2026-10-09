// 界面层验收：AT16 / AT18 / AT19 / AT23 / 9.1 性能 / 9.4 XSS / 九立只读导入 / 标注
import { expect, type Page, test } from "@playwright/test";

async function renderFixture(page: Page, prompt: string, fixtureId: string) {
  await page.goto("/projects/jiuli/playground");
  await page.click(`[data-prompt="${prompt}"]`);
  await page.click(`[data-fixture-id="${fixtureId}"]`);
  await page.click('[data-testid="btn-render"]');
  await expect(page.locator('[data-testid="result-pane"] [role="tab"][aria-selected="true"]')).toHaveText("可视化");
}

test("AT16 JSON 解析失败：显示原文与错误位置，没有虚构表格", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/invalid-json-truncated.txt");
  await expect(page.getByText("原始回复不是合法 JSON")).toBeVisible();
  await expect(page.locator("[data-table-id]")).toHaveCount(0);
  await page.getByRole("tab", { name: "原始 JSON" }).click();
  await expect(page.getByText(/INVALID_JSON/)).toBeVisible();
  await expect(page.locator("[data-error-line]")).toHaveCount(1);
});

test("AT17 Schema 不合法：标明并可从诊断跳到 JSON 路径", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-schema-type-error.json");
  await expect(page.getByText("SCHEMA_INVALID").first()).toBeVisible();
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  await page.getByRole("tab", { name: "结构校验" }).click();
  await page.locator('[data-testid="diag-pointer"]', { hasText: "/output/rows/0/values/quantity" }).click();
  await expect(page.locator('[data-pointer="/output/rows/0/values/quantity"]')).toHaveClass(/ring-stamp/);
});

test("AT18 单元格 / 问题 / 关系边 共享同一选择状态并跨标签保持", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  // 单元格 → JSON 高亮 + 来源
  await page.locator('[data-table-id="orderRows"] [data-row-id="row-1"] [data-field="model"]').click();
  await expect(page.locator('[data-testid="evidence-drawer"]')).toContainText("ABC-01");
  await page.getByRole("tab", { name: "原始 JSON" }).click();
  await expect(page.locator('[data-pointer="/output/rows/0/values/model"]')).toHaveClass(/ring-stamp/);
  // JSON 节点 → 反查到单元格
  await page.locator('[data-pointer="/output/rows/1"]').click();
  await page.locator('[data-pointer="/output/rows/1/values"]').click();
  await page.locator('[data-pointer="/output/rows/1/values/brand"]').click();
  await page.getByRole("tab", { name: "可视化" }).click();
  await expect(page.locator('[data-table-id="orderRows"] [data-row-id="row-2"] [data-field="brand"]')).toHaveClass(/outline-stamp/);
  // 问题 → 定位行/字段 + 证据
  await page.locator("[data-issue-id]", { hasText: "报关单价" }).click();
  await expect(page.locator('[data-table-id="orderRows"] [data-row-id="row-1"] [data-field="customs_unit_price"]')).toHaveClass(/outline-stamp/);
  await expect(page.locator('[data-testid="evidence-drawer"]')).toContainText("USD 11.00");
  await expect(page.locator('[data-testid="selection-pointer"]')).toHaveText("/output/rows/0/conflicts/0");

  // 关系边
  await renderFixture(page, "jiuli-p3", "constructed/p3-v3-multi-candidate.json");
  await page.getByRole("button", { name: "关系图" }).click();
  await page.getByLabel("显示全部委托行").check();
  const edge = page.locator('[data-testid="rf__edge-OR_001|SELECTED|1::IR_B1"], .react-flow__edge[data-id="OR_001|SELECTED|1::IR_B1"]').first();
  await expect(edge).toBeVisible();
  await edge.click({ force: true });
  await expect(page.locator('[data-testid="evidence-drawer"]')).toContainText("E-I-B1-MODEL");
  await page.getByRole("tab", { name: "原始 JSON" }).click();
  await expect(page.locator('[data-pointer="/output/row_relations/0/selected_raw_row_ids"]')).toHaveClass(/ring-stamp/);
});

test("AT19 来源无原文：显示 METADATA_ONLY / MISSING，不提供越权下载", async ({ page }) => {
  await renderFixture(page, "jiuli-p3", "constructed/p3-v3-multi-candidate.json");
  await page.locator('[data-table-id="orderRows"] [data-row-id="OR_001"] [data-field="match_status"]').click();
  await expect(page.locator('[data-testid="evidence-drawer"]').getByText("METADATA_ONLY").first()).toBeVisible();
  await expect(page.locator('[data-testid="evidence-drawer"]').getByText("打开原文件")).toHaveCount(0);
  const res = await page.request.get("/api/materials/F-000000000000/preview");
  expect(res.status()).toBe(403);
  const traversal = await page.request.get(`/api/materials/${encodeURIComponent("../../package.json")}/preview`);
  expect(traversal.status()).toBe(400);
});

test("AT23 运行后修改 Prompt 未再运行：结果标识来自之前运行", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  await expect(page.getByText("当前结果来自上次运行")).toHaveCount(0);
  await page.getByRole("button", { name: /^提示词/ }).click();
  await page.getByLabel("System 提示词").fill("修改后的提示词");
  await expect(page.getByText("当前结果来自上次运行")).toBeVisible();
});

test("9.4 恶意 HTML 片段按文本显示，不执行", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-xss.json");
  await page.getByRole("button", { name: /全部 25 字段/ }).click();
  await expect(page.getByText('<img src=x onerror="window.__xss=1">').first()).toBeVisible();
  await expect(page.getByText("<script>window.__xss=1</script>").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("[data-table-id] img, [data-table-id] script, [data-table-id] svg[onload]").count()).toBe(0);
});

test("未配置模型时不能真实运行，也不会回退为 Mock", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await expect(page.getByTestId("btn-run")).toBeDisabled();
  const res = await page.request.post("/api/runs", { data: { mode: "MODEL_RUN", promptId: "jiuli-p1", snapshotId: "snap_x", system: "", userTemplate: "" } });
  expect(res.status()).toBeGreaterThanOrEqual(400);
});

test("九立只读导入：选客户/任务/批次 → 隔离快照 → 请求预览", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p3"]');
  await page.getByRole("button", { name: "从九立导入" }).click();
  await expect(page.getByTestId("jiuli-import")).toContainText("CONNECTED_DEMO_FILES");
  await expect(page.getByTestId("jiuli-import")).toContainText("真实九立 API 未接通");
  await page.getByLabel("搜索客户").fill("英堡");
  await page.getByRole("button", { name: /英堡科技/ }).click();
  await page.getByLabel("委托任务").selectOption({ index: 1 });
  await page.getByLabel(/选择批次/).first().check();
  await page.getByRole("button", { name: "只读读取并创建隔离快照" }).click();
  await expect(page.getByTestId("snapshot-list")).toContainText("JIULI_READONLY");
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toContainText("jiuli-demo-p3");
  await expect(page.getByTestId("request-preview")).toContainText("retrieval_complete=false");
});

test("请求预览与真实运行使用同一份输入：切换输入来源后不沿用旧快照", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  // 先从九立导入一个快照
  await page.getByRole("button", { name: "从九立导入" }).click();
  await page.getByRole("button", { name: /上海浦壹/ }).click();
  await page.getByLabel("委托任务").selectOption({ index: 1 });
  await page.getByRole("button", { name: "只读读取并创建隔离快照" }).click();
  await expect(page.getByTestId("snapshot-list")).toContainText("JIULI_READONLY");
  // 再切到样本库选录制样本：预览必须是样本自带的请求，而不是刚才的九立快照
  await page.getByRole("button", { name: "样本库" }).click();
  await page.click('[data-fixture-id="v3/SC-08-audit/P1"]');
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toContainText("passthrough-snapshot-request");
  await expect(page.getByTestId("request-preview")).not.toContainText("jiuli-demo-p1");
  // 没有请求上下文的样本：明确说明不能真实运行，不显示其他快照的预览
  await page.getByRole("button", { name: "输入" }).click();
  await page.click('[data-fixture-id="v2/p1-original-output-example.json"]');
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("editor-pane")).toContainText("没有请求上下文");
  await expect(page.getByTestId("request-preview")).toHaveCount(0);
  // 粘贴模式只用于仅渲染：同样不沿用旧快照
  await page.getByRole("button", { name: "输入" }).click();
  await page.getByRole("button", { name: "粘贴 / 文件 JSON" }).click();
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toHaveCount(0);
});

test("刷新页面不丢工作区：草稿、输入选择、当前结果都恢复", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  await renderFixture(page, "jiuli-p3", "constructed/p3-v3-multi-candidate.json");
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  await page.getByRole("button", { name: /^提示词/ }).click();
  await page.getByLabel("System 提示词").fill("刷新前的草稿");
  await page.reload();
  // 仍在 P3，结果重新显示，且标明来自上次运行
  await expect(page.locator('[data-prompt="jiuli-p3"]')).toHaveClass(/bg-ink-800/);
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  await expect(page.getByText("当前结果来自上次运行")).toBeVisible();
  await page.getByRole("button", { name: /^提示词/ }).click();
  await expect(page.getByLabel("System 提示词")).toHaveValue("刷新前的草稿");
  await expect(page.getByText("未保存草稿")).toBeVisible();
  await page.getByRole("button", { name: "输入" }).click();
  await expect(page.locator('[data-fixture-id="constructed/p3-v3-multi-candidate.json"]')).toHaveClass(/ring-stamp/);
  expect(consoleErrors).toEqual([]);
});

test("模型运行中显示已等待秒数；刷新页面后仍接着等待并自动显示结果；截断有明确提示", async ({ page }) => {
  // 用一个已有的 Run 模拟"刚开始的模型运行"：finished 之前查询返回 RUNNING，之后返回真实结果（并标为截断）
  await renderFixture(page, "jiuli-p1", "v3/SC-08-audit/P1");
  const runs = await page.request.get("/api/runs?project=jiuli&promptId=jiuli-p1").then((r) => r.json());
  const runId: string = runs.data[0].run_id;
  let finished = false;
  await page.route(`**/api/runs/${runId}`, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    if (!finished) body.data.run = { ...body.data.run, status: "RUNNING", view_model: null, started_at: new Date(Date.now() - 5000).toISOString() };
    else body.data.run = { ...body.data.run, finish_reason: "length" };
    await r.fulfill({ response: res, json: body });
  });
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { ok: true, data: { provider: "openai-compatible@fake", model: "fake", configured: true, supportsFileInput: false, adapterVersion: "1.0.0" }, request_id: "x" } }),
  );
  await page.route("**/api/runs", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 202, json: { ok: true, data: { run_id: runId, status: "RUNNING" }, request_id: "x" } }) : r.continue()));
  await page.reload();
  await page.getByTestId("btn-run").click();
  await expect(page.getByTestId("running-banner")).toContainText("已等待");
  // 运行中不能重复发起
  await expect(page.getByTestId("btn-run")).toBeDisabled();
  // 运行中刷新页面：仍显示这条运行，结束后自动显示结果
  await page.reload();
  await expect(page.getByTestId("running-banner")).toBeVisible();
  finished = true;
  await expect(page.getByTestId("running-banner")).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByText("被截断（finish_reason=length）")).toBeVisible();
  await page.getByRole("tab", { name: "运行信息" }).click();
  await expect(page.getByText("达到 max_tokens 被截断")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("模型调用失败时先给中文原因与建议，服务商原文收在详情里", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const runs = await page.request.get("/api/runs?project=jiuli&promptId=jiuli-p1").then((r) => r.json());
  const runId: string = runs.data[0].run_id;
  await page.route(`**/api/runs/${runId}`, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.data.run = { ...body.data.run, mode: "MODEL_RUN", status: "MODEL_ERROR", view_model: null, error: { code: "MODEL_HTTP_404", message: '{"error":"model Qwen-X not found"}' } };
    await r.fulfill({ response: res, json: body });
  });
  await page.reload();
  const banner = page.getByTestId("model-error");
  await expect(banner).toContainText("找不到模型或接口地址");
  await expect(banner).toContainText("MODEL_NAME");
  await expect(banner.getByText("model Qwen-X not found")).toBeHidden();
  await banner.getByText(/^详情/).click();
  await expect(banner.getByText(/MODEL_HTTP_404 — .*model Qwen-X not found/)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("模型运行开始前的错误直接显示在顶栏，不出现运行中提示", async ({ page }) => {
  await page.route("**/api/models", (r) =>
    r.fulfill({ json: { ok: true, data: { provider: "openai-compatible@fake", model: "fake", configured: true, supportsFileInput: false, adapterVersion: "1.0.0" }, request_id: "x" } }),
  );
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.click('[data-fixture-id="v3/SC-08-audit/P1"]');
  await page.route("**/api/runs", (r) =>
    r.request().method() === "POST" ? r.fulfill({ status: 400, json: { ok: false, error: { code: "FILE_INPUT_UNSUPPORTED", message: "模拟阻断" }, request_id: "x" } }) : r.continue(),
  );
  await page.getByTestId("btn-run").click();
  await expect(page.getByTestId("error-message")).toContainText("FILE_INPUT_UNSUPPORTED");
  await expect(page.getByTestId("running-banner")).toHaveCount(0);
});

test("AT26 快照刷新生成新快照（记录来源），快照列表按 Prompt 过滤", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByRole("button", { name: "从九立导入" }).click();
  await page.getByRole("button", { name: /上海浦壹/ }).click();
  await page.getByLabel("委托任务").selectOption({ index: 1 });
  await page.getByRole("button", { name: "只读读取并创建隔离快照" }).click();
  const list = page.getByTestId("snapshot-list");
  // 等列表刷新出刚创建并选中的九立快照，再取它的 ID
  const created = list.locator("[data-snapshot-id].ring-1");
  await expect(created).toContainText("JIULI_READONLY");
  const oldId = await created.getAttribute("data-snapshot-id");
  await page.getByRole("button", { name: `刷新快照 ${oldId}` }).click();
  await expect(list).toContainText(`刷新自 ${oldId}`);
  const selected = list.locator("[data-snapshot-id].ring-1");
  await expect(selected).not.toHaveAttribute("data-snapshot-id", oldId!);
  await expect(selected).toContainText(`刷新自 ${oldId}`);
  // P4 无法从九立快照构造输入：默认隐藏，显示全部时标为不适用且不可选
  await page.click('[data-prompt="jiuli-p4"]');
  await page.getByRole("button", { name: "已有快照" }).click();
  await expect(list).toContainText("不适用");
  await expect(list.locator(`[data-snapshot-id="${oldId}"]`)).toHaveCount(0);
  await page.getByLabel("显示全部快照").check();
  await expect(list.locator(`[data-snapshot-id="${oldId}"]`)).toBeDisabled();
});

test("窄屏（<1280px）编辑区与结果区改为可切换页签，运行后自动切到结果", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/projects/jiuli/playground");
  const tabs = page.getByTestId("narrow-tabs");
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId("editor-pane")).toBeVisible();
  await expect(page.getByTestId("result-pane")).toHaveCount(0);
  await page.click('[data-prompt="jiuli-p1"]');
  await page.click('[data-fixture-id="constructed/p1-v3-conflict.json"]');
  await page.click('[data-testid="btn-render"]');
  await expect(page.getByTestId("result-pane")).toBeVisible();
  await expect(page.getByTestId("editor-pane")).toHaveCount(0);
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  await tabs.getByRole("button", { name: "编辑" }).click();
  await expect(page.getByTestId("editor-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  // 宽屏恢复三栏
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(tabs).toHaveCount(0);
  await expect(page.getByTestId("editor-pane")).toBeVisible();
  await expect(page.getByTestId("result-pane")).toBeVisible();
});

test("快照可设置保留期限、可删除；历史 Run 保留并标明快照已删除", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "v3/SC-08-audit/P1");
  await page.getByRole("button", { name: "已有快照" }).click();
  const item = page.getByTestId("snapshot-list").locator("li", { hasText: "样本 · SC-08-audit · P1" }).first();
  const id = await item.locator("[data-snapshot-id]").getAttribute("data-snapshot-id");
  await page.getByLabel(`保留期限 ${id}`).selectOption("30");
  await expect(page.getByLabel(`保留期限 ${id}`)).toContainText("至 ");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `删除快照 ${id}` }).click();
  await expect(page.locator(`[data-snapshot-id="${id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: /运行历史/ }).click();
  await page.getByTestId("history").getByRole("button", { name: "回放" }).first().click();
  await page.getByRole("tab", { name: "运行信息" }).click();
  await expect(page.getByTestId("tab-meta")).toContainText("已删除或到期");
});

test("多项目：新建项目、切换项目，运行按项目隔离；不存在的项目有明确提示", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  const name = `E2E 项目 ${Date.now()}`;
  await page.getByLabel("项目名称").fill(name);
  await page.getByTestId("new-project-form").getByRole("button", { name: "创建" }).click();
  await expect(page).toHaveURL(/\/projects\/proj_[^/]+\/playground/);
  await expect(page.getByLabel("切换项目")).toHaveValue(/proj_/);
  await expect(page.locator("header")).toContainText(name);
  await expect(page.getByTestId("sidebar").locator("[data-prompt]")).toHaveCount(5);
  await page.getByTestId("sidebar").locator("[data-prompt]").filter({ hasText: "委托材料识别" }).click();
  await page.click('[data-fixture-id="constructed/p1-v3-conflict.json"]');
  await page.click('[data-testid="btn-render"]');
  await expect(page.locator('[data-table-id="orderRows"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "运行历史（1）" })).toBeVisible();
  await page.getByLabel("切换项目").selectOption("jiuli");
  await expect(page).toHaveURL(/\/projects\/jiuli\/playground/);
  await expect(page.getByRole("button", { name: /运行历史（\d{2,}\+?）/ })).toBeVisible();
  await page.goto("/projects/no-such-project/playground");
  await expect(page.getByTestId("project-missing")).toBeVisible();
});

test("上传原件：伪装文件被拒绝；Excel 委托单建快照后可预览 P1 输入", async ({ page }) => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["型号", "数量"], ["UPLOAD-01", 5]]), "委托");
  const xlsx = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByRole("button", { name: "上传文件" }).click();
  // 伪装成 PDF 的文本文件
  await page.getByLabel("选择原件文件").setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await page.getByRole("button", { name: "上传并创建隔离快照" }).click();
  await expect(page.getByTestId("upload-input")).toContainText("内容与扩展名不符");
  await page.getByRole("button", { name: "移除 fake.pdf" }).click();
  await page.getByLabel("选择原件文件").setInputFiles({ name: "委托.xlsx", mimeType: "application/octet-stream", buffer: xlsx });
  await expect(page.getByLabel("材料类型 委托.xlsx")).toHaveValue("ORDER");
  await page.getByLabel("客户名称").fill("上传测试客户");
  await page.getByRole("button", { name: "上传并创建隔离快照" }).click();
  await expect(page.getByTestId("upload-result")).toContainText("已创建快照");
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toContainText("file-import-p1");
  await expect(page.getByTestId("request-preview")).toContainText("UPLOAD-01");
  await expect(page.getByTestId("request-preview")).toContainText("上传测试客户");
});

test("运行对比：显示关键指标、提示词差异区与输出差异", async ({ page }) => {
  await renderFixture(page, "jiuli-p3", "constructed/p3-v3-multi-candidate.json");
  await page.click('[data-fixture-id="constructed/p3-v3-unknown-enum.json"]');
  await page.click('[data-testid="btn-render"]');
  await page.getByRole("button", { name: /运行历史/ }).click();
  // 等第二次渲染出现在历史顶部再勾选，避免列表刷新导致勾到同一行
  const rows = page.getByTestId("history").locator("tbody tr");
  await expect(rows.nth(0)).toContainText("P3 未知枚举");
  await expect(rows.nth(1)).toContainText("P3 一对多");
  const boxes = page.getByTestId("history").getByRole("checkbox");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole("button", { name: "对比 2/2" }).click();
  const dialog = page.getByRole("dialog", { name: "对比两次运行" });
  await expect(dialog.getByTestId("compare-metrics")).toContainText("Schema 错误数");
  await expect(dialog.getByTestId("compare-metrics")).toContainText("原始响应 Hash");
  await expect(dialog.getByText("至少一方没有记录实际发送的提示词").first()).toBeVisible();
  await expect(dialog.getByText("输出 JSON 差异")).toBeVisible();
});

test("重渲染 / 回放 / 保存版本失败时显示错误，不静默", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const boom = (code: string) => (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message: "模拟失败" }, request_id: "x" }) });
  await page.getByRole("button", { name: /运行历史/ }).click();
  await page.route("**/api/runs/*/re-render", boom("RERENDER_BOOM"));
  await page.getByTestId("history").getByRole("button", { name: "重渲染" }).first().click();
  await expect(page.getByTestId("error-message")).toContainText("RERENDER_BOOM");
  await page.route(/\/api\/runs\/run_[^/]+$/, boom("REPLAY_BOOM"));
  await page.getByTestId("history").getByRole("button", { name: "回放" }).first().click();
  await expect(page.getByTestId("error-message")).toContainText("REPLAY_BOOM");
  await page.route("**/api/prompts/*/versions", boom("SAVE_BOOM"));
  await page.getByRole("button", { name: /^提示词/ }).click();
  await page.getByLabel("System 提示词").fill("改动");
  await page.getByLabel("新版本名称").fill("会失败的版本");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page.getByTestId("error-message")).toContainText("SAVE_BOOM");
  await expect(page.getByLabel("新版本名称")).toHaveValue("会失败的版本");
});

test("项目可改名、归档、恢复；项目内可新建提示词；默认项目不能归档", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: `管理测试 ${Date.now()}`, template: "BLANK" } }).then((r) => r.json());
  const pid: string = created.data.project_id;
  await page.goto(`/projects/${pid}/playground`);
  const sidebar = page.getByTestId("sidebar");
  // 改名
  const newName = `改名后 ${Date.now()}`;
  await sidebar.getByRole("button", { name: "改名" }).click();
  await page.getByLabel("新项目名称").fill(newName);
  await page.getByTestId("rename-project-form").getByRole("button", { name: "保存" }).click();
  await expect(page.locator("header")).toContainText(newName);
  // 新建提示词（P3），创建后自动选中
  await sidebar.getByRole("button", { name: "新建提示词" }).click();
  await page.getByLabel("提示词名称").fill("P3 实验版");
  await page.getByLabel("提示词种类").selectOption("JIULI_P3");
  await page.getByTestId("new-prompt-form").getByRole("button", { name: "创建" }).click();
  await expect(sidebar.locator("[data-prompt]")).toHaveCount(2);
  await expect(page.locator("header")).toContainText("P3 实验版");
  await page.getByRole("button", { name: /^提示词/ }).click();
  await expect(page.getByLabel("System 提示词")).toHaveValue(/P3/);
  // 归档：先取消一次
  page.once("dialog", (d) => d.dismiss());
  await sidebar.getByRole("button", { name: "归档" }).click();
  await expect(page).toHaveURL(new RegExp(pid));
  page.once("dialog", (d) => d.accept());
  await sidebar.getByRole("button", { name: "归档" }).click();
  await expect(page).toHaveURL(/\/projects\/jiuli\/playground/);
  // 默认项目没有归档按钮
  await expect(sidebar.getByRole("button", { name: "归档" })).toHaveCount(0);
  await expect(page.getByLabel("切换项目").locator("option", { hasText: `${newName}（已归档）` })).toHaveCount(1);
  // 进入已归档项目可恢复，数据还在
  await page.getByLabel("切换项目").selectOption(pid);
  await expect(page.getByTestId("project-archived")).toBeVisible();
  await expect(sidebar.locator("[data-prompt]")).toHaveCount(2);
  await page.getByTestId("project-archived").getByRole("button", { name: "恢复" }).click();
  await expect(page.getByTestId("project-archived")).toHaveCount(0);
  await expect(page.getByLabel("切换项目").locator("option", { hasText: "（已归档）" }).filter({ hasText: newName })).toHaveCount(0);
});

test("请求预览可展开 system 全文，并能复制全部发送内容", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByRole("button", { name: /^提示词/ }).click();
  await expect(page.getByText("与版本一致")).toBeVisible();
  const system = await page.getByLabel("System 提示词").inputValue();
  const tail = system.trim().slice(-30);
  await page.getByRole("button", { name: "输入" }).click();
  await page.getByRole("button", { name: "样本库" }).click();
  await page.click('[data-fixture-id="v3/SC-08-audit/P1"]');
  await page.getByRole("button", { name: "请求预览" }).click();
  const text = page.getByTestId("preview-text");
  await expect(text).toContainText("已折叠");
  await expect(text).not.toContainText(tail);
  await page.getByRole("button", { name: /展开 system 全文/ }).click();
  await expect(text).toContainText(tail);
  await page.getByRole("button", { name: "复制全部发送内容" }).click();
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(tail);
  expect(clip).toContain("# user");
});

test("切换 Prompt 时带上可用的快照；不适用或已有选择时不带", async ({ page }) => {
  const project = await page.request.post("/api/projects", { data: { name: `快照带入 ${Date.now()}`, template: "JIULI" } }).then((r) => r.json());
  const pid: string = project.data.project_id;
  await page.goto(`/projects/${pid}/playground`);
  await page.getByRole("button", { name: "从九立导入" }).click();
  await page.getByRole("button", { name: /上海浦壹/ }).click();
  await page.getByLabel("委托任务").selectOption({ index: 1 });
  await page.getByLabel(/选择批次/).first().check();
  await page.getByRole("button", { name: "只读读取并创建隔离快照" }).click();
  const selected = page.getByTestId("snapshot-list").locator("[data-snapshot-id].ring-1");
  await expect(selected).toContainText("JIULI_READONLY");
  const snapId = await selected.getAttribute("data-snapshot-id");
  const sidebar = page.getByTestId("sidebar").locator("[data-prompt]");
  // P3 可用：自动带上，预览直接是九立 P3 构造
  await sidebar.filter({ hasText: "商品对应关系" }).click();
  await expect(page.getByTestId("editor-pane")).toContainText(`快照 ${snapId}`);
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toContainText("jiuli-demo-p3");
  // P4 不适用：不带
  await sidebar.filter({ hasText: "字段核验" }).click();
  await expect(page.getByTestId("editor-pane")).not.toContainText(`快照 ${snapId}`);
  // P2 先选了样本：不覆盖
  await sidebar.filter({ hasText: "查货材料识别" }).click();
  await page.getByRole("button", { name: "输入" }).click();
  await page.click('[data-fixture-id="constructed/p2-v3-no-warehouse.json"]');
  await sidebar.filter({ hasText: "商品对应关系" }).click();
  await sidebar.filter({ hasText: "查货材料识别" }).click();
  await expect(page.getByTestId("editor-pane")).toContainText("样本 constructed/p2-v3-no-warehouse.json");
});

test("粘贴的请求可一键存为快照并选中，直接用于真实运行的预览", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.locator('[data-prompt="generic-json"]').click();
  await page.getByRole("button", { name: "粘贴 / 文件 JSON" }).click();
  const btn = page.getByRole("button", { name: "请求存为快照（用于真实运行）" });
  await expect(btn).toBeDisabled();
  const marker = `请总结-${Date.now()}`;
  await page.getByLabel("请求上下文", { exact: true }).fill(JSON.stringify({ text: marker }));
  await btn.click();
  await expect(page.getByTestId("snapshot-list").locator("[data-snapshot-id].ring-1")).toContainText("粘贴的请求");
  await page.getByRole("button", { name: "请求预览" }).click();
  await expect(page.getByTestId("request-preview")).toContainText(marker);
  // 不合法的 JSON 明确报错
  await page.getByRole("button", { name: "输入" }).click();
  await page.getByRole("button", { name: "粘贴 / 文件 JSON" }).click();
  await page.getByLabel("请求上下文", { exact: true }).fill("{不是 JSON");
  await page.getByRole("button", { name: "请求存为快照（用于真实运行）" }).click();
  await expect(page.getByTestId("editor-pane")).toContainText("INVALID_JSON");
});

test("运行历史只列当前 Prompt，超过 100 条可加载更多；没有记录时显示空状态", async ({ page }) => {
  const project = await page.request.post("/api/projects", { data: { name: `历史分页 ${Date.now()}`, template: "JIULI" } }).then((r) => r.json());
  const pid: string = project.data.project_id;
  const raw = await page.request.get("/api/fixtures/item?id=constructed/p1-v3-conflict.json").then((r) => r.json());
  for (let i = 0; i < 101; i++) {
    await page.request.post("/api/runs", { data: { mode: "RENDER_ONLY", projectId: pid, promptId: `${pid}-p1`, raw: raw.data.raw, label: `批量 ${i}` } });
  }
  await page.goto(`/projects/${pid}/playground`);
  // 进入项目默认落在 P1，而不是通用 JSON
  await expect(page.locator("header")).toContainText("P1 委托材料识别");
  await page.getByRole("button", { name: "运行历史（100+）" }).click();
  const rows = page.getByTestId("history").locator("tbody tr");
  await expect(rows).toHaveCount(100);
  await page.getByRole("button", { name: /加载更多/ }).click();
  await expect(rows).toHaveCount(101);
  await expect(page.getByRole("button", { name: /加载更多/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "运行历史（101）" })).toBeVisible();
  // 其他 Prompt 没有记录：显示空状态，不借用 P1 的记录
  await page.getByTestId("sidebar").locator("[data-prompt]").filter({ hasText: "查货材料识别" }).click();
  await expect(page.getByTestId("history")).toContainText("当前 Prompt 还没有运行记录");
  await expect(page.getByTestId("history").locator("tbody tr")).toHaveCount(1);
});

test("未登记 Schema 的结果不显示「解析成功」，结果区与历史均标为未校验", async ({ page }) => {
  await renderFixture(page, "jiuli-p1", "constructed/unknown-schema-version.json");
  const pane = page.getByTestId("result-pane");
  await expect(pane).toContainText("未校验（未登记 Schema）");
  await expect(pane).not.toContainText("解析成功");
  await page.getByRole("button", { name: /运行历史/ }).click();
  const row = page.getByTestId("history").locator("tr", { hasText: "未登记 schema_version" }).first();
  await expect(row).toContainText("未校验（未登记 Schema）");
  await expect(row).not.toContainText("解析成功");
});

test("顶栏显示当前 Prompt 版本，有未保存修改时标为草稿", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p4"]');
  await page.getByRole("button", { name: /^提示词/ }).click();
  await expect(page.getByText("与版本一致")).toBeVisible();
  const header = page.getByTestId("header-version");
  const label = await page.getByLabel("Prompt 版本").locator("option:checked").textContent();
  await expect(header).toContainText(label!.split(" · ")[0]);
  await expect(header).not.toContainText("未保存草稿");
  const system = page.getByLabel("System 提示词");
  await system.fill(`${await system.inputValue()}\n# 顶栏版本测试 ${Date.now()}`);
  await expect(header).toContainText("未保存草稿");
  const name = `顶栏版本 ${Date.now()}`;
  await page.getByLabel("新版本名称").fill(name);
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(header).toContainText(name);
  await expect(header).not.toContainText("未保存草稿");
});

test("版本加载完成前就开始输入：输入内容保留为草稿，不被最新版本覆盖", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/prompts\/jiuli-p3$/, async (r) => {
    await gate;
    await r.continue();
  });
  await page.goto("/projects/jiuli/playground");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('[data-prompt="jiuli-p3"]');
  await page.getByRole("button", { name: /^提示词/ }).click();
  const typed = `抢先输入 ${Date.now()}`;
  await page.getByLabel("System 提示词").fill(typed);
  release();
  await expect(page.getByLabel("Prompt 版本")).not.toHaveValue("");
  await expect(page.getByText("未保存草稿")).toBeVisible();
  await expect(page.getByLabel("System 提示词")).toHaveValue(typed);
});

test("有未保存修改时切换版本先确认：取消则保留草稿，确认才载入旧版本", async ({ page }) => {
  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p2"]');
  await page.getByRole("button", { name: /^提示词/ }).click();
  const system = page.getByLabel("System 提示词");
  const versions = page.getByLabel("Prompt 版本");
  await expect(page.getByText("与版本一致")).toBeVisible();
  const original = await system.inputValue();
  const originalId = await versions.inputValue();
  await system.fill(`${original}\n# 已保存改动 ${Date.now()}`);
  await page.getByLabel("新版本名称").fill("切换确认测试");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page.getByText("与版本一致")).toBeVisible();
  const draft = `未保存的重要改动 ${Date.now()}`;
  await system.fill(draft);
  // 取消：草稿保留，版本不变
  let message = "";
  page.once("dialog", (d) => ((message = d.message()), d.dismiss()));
  await versions.selectOption(originalId);
  expect(message).toContain("未保存的修改");
  await expect(system).toHaveValue(draft);
  await expect(page.getByText("未保存草稿")).toBeVisible();
  // 确认：载入旧版本
  page.once("dialog", (d) => d.accept());
  await versions.selectOption(originalId);
  await expect(system).toHaveValue(original);
  await expect(page.getByText("与版本一致")).toBeVisible();
});

test("标注独立保存，不改原始输出", async ({ page }) => {
  await renderFixture(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  await page.locator('[data-change-id="OR_001:gross_weight"]').click();
  await page.getByLabel("正确值").fill("2.4");
  await page.getByLabel("标注备注").fill("模型应选箱单 GW");
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByTestId("annotation-form")).toContainText("正确值：2.4");
  // 有标注的行显示角标；可导出 CSV
  await expect(page.locator('[data-change-id="OR_001:gross_weight"]')).toHaveAttribute("data-annotated", "");
  const csv = await page.request.get("/api/annotations/export?project=jiuli&format=csv").then((r) => r.text());
  expect(csv.startsWith("﻿")).toBe(true);
  expect(csv).toContain("模型应选箱单 GW");
  await page.getByRole("tab", { name: "运行信息" }).click();
  const hash = await page.locator("dd", { hasText: /^[0-9a-f]{64}$/ }).last().textContent();
  const raw = await page.request.get("/api/fixtures/item?id=constructed/p4-v3-conflict.json").then((r) => r.json());
  const crypto = await import("node:crypto");
  expect(hash).toBe(crypto.createHash("sha256").update(raw.data.raw).digest("hex"));
});

test("标注可修改、可删除：删除后角标消失、导出中不再出现", async ({ page }) => {
  await renderFixture(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  const row = page.locator('[data-change-id="OR_001:net_weight"]');
  await row.click();
  const marker = `标注-${Date.now()}`;
  await page.getByLabel("正确值").fill("错写的值");
  await page.getByLabel("标注备注").fill(marker);
  await page.getByRole("button", { name: "保存标注" }).click();
  const form = page.getByTestId("annotation-form");
  await expect(form).toContainText("正确值：错写的值");
  await expect(row).toHaveAttribute("data-annotated", "");
  // 修改
  await form.getByRole("button", { name: /^修改标注/ }).last().click();
  await expect(page.getByLabel("正确值")).toHaveValue("错写的值");
  await page.getByLabel("正确值").fill("1.8");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(form).toContainText("正确值：1.8");
  await expect(form).not.toContainText("错写的值");
  let csv = await page.request.get("/api/annotations/export?project=jiuli&format=csv").then((r) => r.text());
  expect(csv).toContain(marker);
  expect(csv).not.toContain("错写的值");
  // 删除（先取消一次，确认没有误删）
  page.once("dialog", (d) => d.dismiss());
  await form.getByRole("button", { name: /^删除标注/ }).last().click();
  await expect(form).toContainText("正确值：1.8");
  page.once("dialog", (d) => d.accept());
  await form.getByRole("button", { name: /^删除标注/ }).last().click();
  await expect(form).not.toContainText(marker);
  await expect(row).not.toHaveAttribute("data-annotated", "");
  csv = await page.request.get("/api/annotations/export?project=jiuli&format=csv").then((r) => r.text());
  expect(csv).not.toContain(marker);
});

test("P2 按入仓号分组：未确定入仓号单独展示", async ({ page }) => {
  await renderFixture(page, "jiuli-p2", "constructed/p2-v3-no-warehouse.json");
  await page.locator('[data-group="__UNRESOLVED__"]').click();
  await expect(page.getByText("以下原始行没有可靠入仓号")).toBeVisible();
  await expect(page.locator('[data-table-id="inspectionRawRows"] tbody tr')).toHaveCount(1);
  await page.locator('[data-group="26091801"]').click();
  await expect(page.locator('[data-table-id="inspectionRawRows"] tbody tr')).toHaveCount(2);
});

test("P4 只看变化 / 仅风险 过滤", async ({ page }) => {
  await renderFixture(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  const rows = page.locator('[data-table-id="fieldDecisions"] tbody tr');
  await expect(rows).toHaveCount(7);
  await page.locator('[data-preset="changes"]').click();
  await expect(rows).toHaveCount(4);
  await page.locator('[data-preset="risks"]').click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByText("SIMULATION_ONLY").first()).toBeVisible();
});

test("9.1 性能：100 行 × 25 字段（记录实测，不预设达标）", async ({ page }) => {
  const KEYS = ["customer_name", "brand", "model", "description", "product_name", "origin", "unit", "quantity", "customs_unit_price", "total_price", "currency", "packages", "net_weight", "gross_weight", "sku", "buyer", "supplier_code", "supplier", "payment_term_days", "purchase_order_no", "material_no", "pallet_count", "warehouse_no", "production_line", "remark"];
  const rows = Array.from({ length: 100 }, (_, i) => ({
    row_no: i + 1,
    source: { file_id: "F1", page: null, sheet: "S", row: i + 5, column: "B", raw_text: `M-${i}` },
    values: Object.fromEntries(KEYS.map((k) => [k, `${k}-${i}`])),
    evidence: KEYS.map((k) => ({ field: k, value: `${k}-${i}`, unit: "", source: { file_id: "F1", page: null, sheet: "S", row: i + 5, column: "C", raw_text: `${k}-${i}` } })),
    conflicts: [],
  }));
  const doc = { schema_version: "jiuli-ai-v3", prompt: "P1", request_id: "PERF", output: { processing_status: "SUCCESS", customer_resolution: { status: "UNRESOLVED", customer_id: null, recognized_name: "", candidate_customer_ids: [], sources: [] }, read_status: [], rows, scope_records: [], unlinked_records: [], issues: [] } };
  await page.goto("/projects/jiuli/playground");
  await page.getByRole("button", { name: "粘贴 / 文件 JSON" }).click();
  await page.getByLabel("原始输出", { exact: true }).fill(JSON.stringify(doc));
  const t0 = Date.now();
  await page.click('[data-testid="btn-render"]');
  await expect(page.locator('[data-table-id="orderRows"] tbody tr')).toHaveCount(100);
  const renderMs = Date.now() - t0;
  await page.getByRole("button", { name: /全部 25 字段/ }).click();
  const t1 = Date.now();
  await page.getByLabel("筛选 委托商品行（25 字段）").fill("model-77");
  await expect(page.locator('[data-table-id="orderRows"] tbody tr')).toHaveCount(1);
  const filterMs = Date.now() - t1;
  await page.getByLabel("筛选 委托商品行（25 字段）").fill("");
  const t2 = Date.now();
  await page.locator('[data-table-id="orderRows"] > div.overflow-auto').evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = el.scrollHeight;
  });
  await page.locator('[data-row-id="row-100"] [data-field="remark"]').click();
  const scrollClickMs = Date.now() - t2;
  console.log(`PERF 100x25: 渲染(含服务端流水线)=${renderMs}ms 筛选=${filterMs}ms 滚动到末尾并点击=${scrollClickMs}ms`);
  test.info().annotations.push({ type: "perf", description: `render=${renderMs}ms filter=${filterMs}ms scroll+click=${scrollClickMs}ms` });
});
