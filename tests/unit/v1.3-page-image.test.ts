// v1.3 §7.5：Agent 经 MCP 看原件页面图片（扫描件没有文字层时核对用）；授权、Hash 核对与越界处理
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import type { Run } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { createFileSnapshot, resolveMaterialFile } from "@/lib/materials/store";
import { OpenAICompatibleProvider, setProviderForTests } from "@/lib/models/openai-compatible";
import { createGrant, listAudit, type Scope } from "@/lib/repositories/agent-access";
import { resetDbForTests } from "@/lib/repositories/db";
import { modelRun } from "@/lib/runs/service";
import { makePdf } from "./helpers/pdf";

let run: Run;
let fileId: string;
/** 第 1 页上的一条来源，与指向第 9 页（原件只有 3 页）的一条来源 */
let onPage1: string;
let onPage9: string;

beforeAll(async () => {
  resetDbForTests(":memory:");
  process.env.STUDIO_MATERIALS_DIR = mkdtempSync(join(tmpdir(), "studio-pageimg-mat-"));
  const snap = await createFileSnapshot({ projectId: "jiuli", customerName: "测试客户", files: [{ name: "扫描查货.pdf", buffer: makePdf(3), materialType: "INSPECTION" }] });
  fileId = snap.materials[0].file_id;
  // 录制的 SC-08 P2 输出改指向上传的 PDF；第一处页码改成 9（原件不存在的页）
  const raw = getFixture("v3/SC-08/P2")!.raw.split("F-8bc7177252aa").join(fileId).replace(/"page":\s*1/, '"page": 9');
  setProviderForTests(
    new OpenAICompatibleProvider({ baseUrl: "https://model.invalid/v1", model: "fake-model", apiKey: "sk-test-pageimg-abcdef", timeoutMs: 2000 }, (async () =>
      Response.json({ id: "x", model: "fake-model", choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) as unknown as typeof fetch),
  );
  run = await modelRun({ projectId: "jiuli", promptId: "jiuli-p2", snapshotId: snap.snapshot_id, system: "S", userTemplate: "{{input_json}}", params: {}, attachImages: false });
  setProviderForTests(undefined);
  const ev = run.view_model!.evidence.filter((e) => e.fileId === fileId);
  onPage1 = ev.find((e) => e.page === 1)!.id;
  onPage9 = ev.find((e) => e.page === 9)!.id;
}, 60000);

const tok = (scopes?: Scope[]) => createGrant({ principal: "agent-pageimg", projectIds: ["jiuli"], scopes }).token;
async function call(t: string, args: Record<string, unknown>) {
  const res = await POST(
    new Request("http://127.0.0.1:3000/api/mcp", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_source_evidence", arguments: { run_id: run.run_id, ...args } } }),
    }),
  );
  const j = (await res.json()) as { result: { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] } };
  return { isError: !!j.result.isError, content: j.result.content, data: JSON.parse(j.result.content[0].text!) };
}

describe("原件页面图片（view=page_image）", () => {
  it("返回来源所在页的 JPEG 图片内容块；JSON 里有页码、原件 Hash 核对与图片 Hash，图片本身不进文本", async () => {
    const r = await call(tok(), { source_ref: onPage1, view: "page_image" });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(2);
    const img = r.content[1];
    expect(img).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const bytes = Buffer.from(img.data!, "base64");
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(r.data.page_image).toMatchObject({ found: true, page: 1, media_type: "image/jpeg", image_sha256: createHash("sha256").update(bytes).digest("hex"), file: { file_id: fileId, hash_matches_record: true } });
    expect(r.content[0].text).not.toContain(img.data!.slice(0, 100));
    expect(listAudit(1)[0]).toMatchObject({ tool: "get_source_evidence", outcome: "ALLOWED", run_id: run.run_id });
  }, 30000);

  it("来源指向不存在的页：如实说明，不返回图片", async () => {
    const r = await call(tok(), { source_ref: onPage9, view: "page_image" });
    expect(r.content).toHaveLength(1);
    expect(r.data.page_image).toMatchObject({ found: false, reason: expect.stringMatching(/只有 3 页/) });
  });

  it("原件在运行后被换过：仍返回图片，但标出 Hash 与记录不一致", async () => {
    const path = (await resolveMaterialFile(fileId)).absolutePath;
    writeFileSync(path, makePdf(4));
    const r = await call(tok(), { source_ref: onPage1, view: "page_image" });
    expect(r.data.page_image).toMatchObject({ found: true, file: { hash_matches_record: false } });
  }, 30000);

  it("不是本 Run 的来源被拒绝；没有 evidence:read 权限被拒绝", async () => {
    expect((await call(tok(), { source_ref: "/output/raw_rows/99/source", view: "page_image" })).data.error.code).toBe("SOURCE_REF_NOT_IN_RUN");
    expect((await call(tok(["runs:read"]), { source_ref: onPage1, view: "page_image" })).data.error.code).toBe("FORBIDDEN");
  });
});
