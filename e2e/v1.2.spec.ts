// v1.2 界面验收：文件夹上传、通用优先、结果区减负
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("prompt-studio-guide-seen", "1"));
});

async function xlsx(rows: (string | number)[][]) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

test("选择文件夹：读取子文件夹，跳过不支持的文件，材料类型按文件名自动判断", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "studio-e2e-folder-"));
  const dir = join(root, "资料");
  mkdirSync(join(dir, "发票"), { recursive: true });
  writeFileSync(join(dir, "委托单.xlsx"), await xlsx([["型号", "数量"], ["FOLDER-01", 3]]));
  writeFileSync(join(dir, "发票", "scan01.xlsx"), await xlsx([["发票号", "金额"], ["INV-9", 12]]));
  writeFileSync(join(dir, "说明.txt"), "不是原件");
  writeFileSync(join(dir, ".DS_Store"), "x");
  try {
    await page.goto("/projects/jiuli/playground");
    await page.click('[data-prompt="jiuli-p1"]');
    await page.getByRole("button", { name: "上传文件" }).click();
    await page.getByLabel("选择文件夹").setInputFiles(dir);
    const list = page.getByTestId("upload-files");
    await expect(list).toContainText("共 2 个文件");
    await expect(page.getByLabel("材料类型 资料/委托单.xlsx")).toHaveValue("ORDER");
    await expect(page.getByLabel("材料类型 资料/发票/scan01.xlsx")).toHaveValue("INVOICE");
    await expect(page.getByTestId("upload-skipped")).toContainText("已跳过");
    await page.getByTestId("upload-skipped").locator("summary").click();
    await expect(page.getByTestId("upload-skipped")).toContainText("资料/说明.txt：不支持的格式 .txt");
    await page.getByRole("button", { name: "上传 2 个文件" }).click();
    await expect(page.getByTestId("upload-result")).toContainText("已上传");
    await page.getByRole("button", { name: "请求预览" }).click();
    await expect(page.getByTestId("request-preview")).toContainText("FOLDER-01");
    await expect(page.getByTestId("request-preview")).toContainText("INV-9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
