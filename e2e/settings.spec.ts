// 网页「模型设置」：接口全部用路由模拟，不真的写配置文件，避免影响其他用例
import { expect, test } from "@playwright/test";

test("顶栏模型徽章打开「模型设置」：测试连接成功后保存，弹窗关闭", async ({ page }) => {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/settings/model", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    sent.push({ method: req.method(), body: req.postDataJSON() });
    const data = req.method() === "POST" ? { ok: true, modelFound: false, modelCount: 3 } : { source: "settings", baseUrl: "", model: "", hasKey: true, keyTail: "1234", modelFound: true, modelCount: 3 };
    await route.fulfill({ json: { ok: true, data, request_id: "x" } });
  });
  await page.goto("/projects/jiuli/playground");
  await page.getByTestId("btn-model-settings").click();
  const dialog = page.getByTestId("model-settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("ms-api-key")).toHaveAttribute("type", "password");
  await dialog.getByTestId("ms-base-url").fill("https://gw.example/v1");
  await dialog.getByTestId("ms-model").fill("qwen-plus");
  await dialog.getByTestId("ms-api-key").fill("sk-e2e-not-real-1234");
  await dialog.getByTestId("ms-test").click();
  await expect(dialog.getByTestId("ms-result")).toContainText("连接成功，可用模型 3 个");
  await expect(dialog.getByTestId("ms-result")).toContainText("列表里没有“qwen-plus”");
  await dialog.getByTestId("ms-save").click();
  await expect(dialog).toHaveCount(0);
  expect(sent.map((s) => s.method)).toEqual(["POST", "PUT"]);
  expect(sent[1].body).toMatchObject({ baseUrl: "https://gw.example/v1", model: "qwen-plus" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("连接失败时显示原因，弹窗不关闭", async ({ page }) => {
  await page.route("**/api/settings/model", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    await route.fulfill({ status: 400, json: { ok: false, error: { code: "CONNECT_FAILED", message: "API 密钥无效或已过期。" }, request_id: "x" } });
  });
  await page.goto("/projects/jiuli/playground");
  await page.getByTestId("btn-model-settings").click();
  const dialog = page.getByTestId("model-settings-dialog");
  await dialog.getByTestId("ms-base-url").fill("https://gw.example/v1");
  await dialog.getByTestId("ms-model").fill("m");
  await dialog.getByTestId("ms-api-key").fill("k");
  await dialog.getByTestId("ms-test").click();
  await expect(dialog.getByTestId("ms-result")).toContainText("API 密钥无效");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("别的网站的请求不能改配置：带外站 Origin 的 PUT 返回 403", async ({ page }) => {
  const res = await page.request.put("/api/settings/model", { headers: { Origin: "https://evil.example" }, data: { baseUrl: "https://gw.example/v1", model: "m", apiKey: "k" } });
  expect(res.status()).toBe(403);
  const info = await page.request.get("/api/settings/model").then((r) => r.json());
  expect(info.data.source).not.toBe("settings");
});
