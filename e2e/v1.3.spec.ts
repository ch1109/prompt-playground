// v1.3 界面验收：以「结果检查」为中心的交互重构。不预设工作模式，按新用户首次进入的默认状态操作。
import { expect, type Page, test } from "@playwright/test";

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
  await expect(page.getByTestId("selection-pointer")).toHaveAttribute("title", "/output/rows/0/values/origin");
  // 有冲突的字段排在展开区最前
  await expect(fields.locator("button").first()).toContainText("冲突");
});

test("检查动作：选中字段可一键标「对」，模型原始输出不变；可只看有问题的行", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  const currentRun = () => page.evaluate(() => JSON.parse(localStorage.getItem("prompt-studio:workspace") ?? "{}").state?.workspaces?.["jiuli-p1"]?.runId ?? null);
  await expect.poll(currentRun).not.toBeNull();
  const runId: string = await currentRun();
  const before = await page.request.get(`/api/runs/${runId}`).then((r) => r.json());
  const table = page.locator('[data-table-id="orderRows"]');
  await table.locator("tbody tr").first().locator('[data-field="model"]').click();
  const verdict = page.getByTestId("field-verdict");
  await expect(verdict).toContainText("型号");
  await page.getByTestId("btn-mark-correct").click();
  await expect(page.getByTestId("btn-mark-correct")).toHaveText("✓ 已标为正确");
  await expect(page.getByTestId("evidence-drawer")).toContainText("标注正确");
  const after = await page.request.get(`/api/runs/${runId}`).then((r) => r.json());
  expect(after.data.run.raw_response_hash).toBe(before.data.run.raw_response_hash);
  expect(after.data.annotations.some((a: { assessment: string }) => a.assessment === "CORRECT")).toBe(true);
  // 「错」在原地展开，光标直接到「错在哪」（必选）
  await page.getByTestId("btn-mark-wrong").click();
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
  await page.getByTestId("work-modes").getByRole("tab", { name: "版本对比" }).click();
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
  await expect(head).toContainText("未调用模型");
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
    await page.getByTestId("btn-mark-wrong").click();
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
  // 平时只有搜索框，其余筛选收在「筛选」里
  await list.getByTestId("btn-fixture-filters").click();
  await list.getByLabel("能否真实运行").selectOption("render");
  await expect(list.locator('[data-fixture-id="constructed/p4-v3-conflict.json"]')).toHaveCount(0);
  await list.getByLabel("能否真实运行").selectOption("");
  await list.getByLabel("只看运行过的").check();
  await expect(list.locator('[data-fixture-id="constructed/p4-v3-conflict.json"]')).toBeVisible();
  for (const stats of await list.getByTestId("fixture-stats").allTextContents()) expect(stats).not.toMatch(/运行 0/);
});

test("M1 提示词三层：编辑区与已保存版本的差异可展开；当前结果那次运行用的提示词与编辑区不同时可对照", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await expect(page.getByTestId("result-headline")).toBeVisible();
  // 等页面上的请求都结束再刷新，避免刷新中止进行中的请求
  await page.waitForLoadState("networkidle");
  // 把当前结果模拟成一次真实运行：运行时用的是另一段提示词
  await page.route(/\/api\/runs\/run_[^/]+$/, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.data.run = { ...body.data.run, mode: "MODEL_RUN", prompt_source: { system: "运行时的旧规则", user_template: "{{input_json}}" } };
    await r.fulfill({ response: res, json: body });
  });
  await page.reload();
  await page.getByTestId("work-modes").getByRole("tab", { name: "提示词调试" }).click();
  await page.getByTestId("editor-pane").getByRole("button", { name: "提示词", exact: true }).click();
  await expect(page.getByTestId("draft-diff")).toHaveCount(0);
  const layer = page.getByTestId("run-prompt-layer");
  await expect(layer).toContainText("用的提示词与编辑区不同");
  await layer.locator("summary").click();
  await expect(layer.getByTestId("prompt-diff").first()).toContainText("-运行时的旧规则");
  // 改动编辑区：出现与已保存版本的差异
  const sys = page.getByLabel("System 提示词");
  await sys.fill(`${await sys.inputValue()}\n新增一条测试规则`);
  const diff = page.getByTestId("draft-diff");
  await expect(diff).toBeVisible();
  await diff.locator("summary").click();
  await expect(diff.getByTestId("prompt-diff").first()).toContainText("+新增一条测试规则");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("M1 版本对比：两次运行用的样本不同时，明确提示「输入不可直接比较」", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "constructed/p1-v3-conflict.json");
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await page.getByTestId("work-modes").getByRole("tab", { name: "版本对比" }).click();
  const boxes = page.getByTestId("compare-mode").getByRole("checkbox");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const banner = page.getByRole("region", { name: "对比两次运行" }).getByTestId("input-not-comparable");
  await expect(banner).toContainText("输入不可直接比较");
  await expect(banner).toContainText("输入不同");
});

test("修复：切换提示词时，较慢返回的旧历史请求不会覆盖当前提示词的运行历史", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  const p1Count = await page.request.get("/api/runs?project=jiuli&promptId=jiuli-p1").then(async (r) => (await r.json()).data.length as number);
  // 通用提示词的历史请求故意慢 1.5 秒返回
  await page.route(/\/api\/runs\?.*promptId=generic-json/, async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await page.click('[data-prompt="generic-json"]');
  await page.click('[data-prompt="jiuli-p1"]');
  await page.waitForTimeout(2500);
  await expect(page.getByRole("button", { name: /运行历史（/ })).toContainText(`运行历史（${p1Count >= 100 ? "100+" : p1Count}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("修复：读取当前结果时刷新页面（请求被中止），刷新后仍保留当前结果", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await expect(page.getByTestId("result-headline")).toBeVisible();
  await page.waitForLoadState("networkidle");
  // 让读取运行详情变慢：第一次刷新后的读取还没返回，就再刷新一次（前一个请求被中止）
  await page.route(/\/api\/runs\/run_[^/]+$/, async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue().catch(() => {});
  });
  const pending = page.waitForRequest(/\/api\/runs\/run_[^/]+$/);
  await page.reload();
  await pending;
  await page.reload();
  await expect(page.getByTestId("result-headline")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("M2 字段抽屉：复制 Agent 诊断指令，内容带 Run ID、字段定位和人工标注的期望值", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await page.locator('[data-table-id="orderRows"] [data-row-id="row-2"] [data-field="origin"]').first().click();
  const verdict = page.getByTestId("field-verdict");
  await page.getByTestId("btn-mark-wrong").click();
  await page.getByLabel("错误归因").selectOption("UNKNOWN");
  await page.getByLabel("正确值").fill("美国-诊断");
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByTestId("annotation-form")).toContainText("正确值：美国-诊断");
  await verdict.getByTestId("btn-copy-diagnosis").click();
  await expect(verdict.getByTestId("btn-copy-diagnosis")).toHaveText("已复制");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/目标 Run：run_[0-9a-f]+（P1）/);
  expect(text).toContain('"row_id":"row-2","field":"origin"');
  expect(text).toContain("期望值是「美国-诊断」");
  expect(text).toMatch(/只读诊断/);
});

test("M3 修改建议：先看一句结论和计数，详情里有修改内容与逐样本说明；证据不足时须勾选确认才能采纳；采纳后成为正式版本，拒绝不影响正式版本", async ({ page }) => {
  const { DatabaseSync } = await import("node:sqlite");
  const prompt = (await (await page.request.get("/api/prompts/jiuli-p1")).json()).data as { versions: { version_id: string; label: string; system_prompt: string; user_prompt_template: string; content_hash: string; is_stable: boolean }[] };
  const base = prompt.versions.find((v) => !v.is_stable) ?? prompt.versions[0];
  const raw = ((await (await page.request.get("/api/fixtures/item?id=v3/SC-08/P1")).json()).data as { raw: string }).raw;
  // 仅渲染的两次结果充当基线 / 候选（e2e 不调用真实模型）：基线把 column 写成数字（结构不符），候选正常
  const render = async (r: string) => ((await (await page.request.post("/api/runs", { data: { mode: "RENDER_ONLY", promptId: "jiuli-p1", raw: r } })).json()).data as { run_id: string }).run_id;
  const badRun = await render(raw.replace(/"column":\s*"([A-Z]+)"/g, (_m, c: string) => `"column": ${c.charCodeAt(0) - 64}`));
  const goodRun = await render(raw);
  const regBase = await render(raw);
  const regCand = await render(raw);
  const tag = Date.now().toString(36);
  const d = new DatabaseSync("data/e2e.db");
  const addCandidate = (id: string, reason: string) =>
    d.prepare("INSERT INTO prompt_candidates (candidate_id, prompt_id, base_version_id, system_prompt, user_prompt_template, content_hash, reason, diagnosis_ref, created_by, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id, "jiuli-p1", base.version_id, `${base.system_prompt}\nSource.column 必须是字符串-${tag}`, base.user_prompt_template, `h-${id}`, reason, "run_x#/output", "e2e-agent", new Date().toISOString(), "DRAFT");
  const sample = (sample_id: string, role: string, b: string, c: string) => ({ sample_id, role, snapshot_id: `snap_none_${tag}`, baseline_run_id: b, baseline_reused: true, candidate_run_id: c, params: {}, error: null });
  for (const [cid, reason] of [[`cand_a_${tag}`, `修 column 类型 ${tag}`], [`cand_b_${tag}`, `要拒绝的候选 ${tag}`]]) {
    addCandidate(cid, reason);
    const body = { base_version_id: base.version_id, model: "fake", budget: { max_model_runs: 4, planned_model_runs: 2, used_model_runs: 2 }, samples: [sample("v3/SC-08/P1", "TARGET", badRun, goodRun), sample("v3/2026AG001-audit/P1", "REGRESSION", regBase, regCand)], report: null, error: null };
    d.prepare("INSERT INTO experiments VALUES (?,?,?,?,?,?,?,?,?,?)").run(`exp_${cid}`, cid, "jiuli-p1", "jiuli", null, "COMPLETED", "e2e-agent", new Date().toISOString(), new Date().toISOString(), JSON.stringify(body));
  }
  d.close();

  await page.goto("/projects/jiuli/playground");
  await page.click('[data-prompt="jiuli-p1"]');
  await page.getByTestId("work-modes").getByRole("tab", { name: "提示词调试" }).click();
  await page.getByRole("button", { name: "修改建议" }).click();
  const card = page.locator(`[data-candidate-id="cand_a_${tag}"]`);
  await expect(card).toContainText("等你决定");
  // 第一眼：一句结论 + 三个计数；修改内容与逐样本情况在「查看详情」里
  await expect(card.getByTestId("experiment-conclusion")).toContainText("先别急着采纳");
  await expect(card.getByTestId("experiment-counts")).toContainText("修好 1");
  await card.getByText("查看详情").click();
  await expect(card).toContainText(`Source.column 必须是字符串-${tag}`);
  await expect(card.locator('[data-testid="experiment-sample"][data-verdict="FIXED"]')).toContainText("格式错误从");
  await expect(card.locator('[data-testid="experiment-sample"][data-verdict="NO_CHANGE"]')).toContainText("v3/2026AG001-audit/P1");
  // 采纳：在原地确认；结论不是「可以采纳」时须勾选确认
  await card.getByTestId("btn-approve-candidate").click();
  await expect(card.getByLabel("新版本名称")).not.toHaveValue("");
  await card.getByLabel("新版本名称").fill(`采纳-${tag}`);
  await expect(card.getByTestId("btn-confirm-decision")).toBeDisabled();
  await card.getByText("我看过详情，仍然要采纳").click();
  await card.getByTestId("btn-confirm-decision").click();
  await expect(card).toContainText("已采纳");
  // 新版本成为正式版本
  await page.getByRole("button", { name: "提示词", exact: true }).click();
  await expect(page.getByLabel("Prompt 版本").locator("option", { hasText: `采纳-${tag}` })).toContainText("【正式】");
  // 拒绝另一个：正式版本不变
  await page.getByRole("button", { name: "修改建议" }).click();
  const other = page.locator(`[data-candidate-id="cand_b_${tag}"]`);
  await other.getByTestId("btn-reject-candidate").click();
  await other.getByTestId("btn-confirm-decision").click();
  await expect(other).toContainText("已拒绝");
  const after = (await (await page.request.get("/api/prompts/jiuli-p1")).json()).data as { versions: { label: string; is_stable: boolean }[] };
  expect(after.versions.find((v) => v.is_stable)?.label).toBe(`采纳-${tag}`);
});

test("结果页规则检查：P2 / P3 / P4 显示九立硬规则对照结果；有违反时逐条列出，点一条定位到对应格子；P1 不显示", async ({ page }) => {
  await pickInDrawer(page, "jiuli-p3", "v3/SC-08/P3");
  const ok = page.getByTestId("rule-check");
  await expect(ok).toHaveAttribute("data-state", "pass");
  await expect(ok).toContainText("已对照 5 条九立硬规则");

  await pickInDrawer(page, "jiuli-p2", "v3/SC-08/P2");
  await expect(page.getByTestId("rule-check")).toHaveAttribute("data-state", "pass");
  await expect(page.getByTestId("rule-check")).toContainText("已对照 8 条九立硬规则");

  await pickInDrawer(page, "jiuli-p4", "constructed/p4-v3-conflict.json");
  const box = page.getByTestId("rule-check");
  await expect(box).toHaveAttribute("data-state", "fail");
  await expect(box).toContainText("改了人工锁定的字段");
  await expect(box).toContainText("有阻止写入的未解决问题却改了值");
  await box.getByTestId("rule-violation").filter({ hasText: "改了人工锁定的字段" }).click();
  await expect(page.getByTestId("field-verdict")).toBeVisible();
  await expect(page.getByTestId("field-verdict")).toContainText("韩国");

  await pickInDrawer(page, "jiuli-p1", "v3/SC-08/P1");
  await expect(page.getByTestId("result-headline")).toBeVisible();
  await expect(page.getByTestId("rule-check")).toHaveCount(0);
});
