// 网页「模型设置」：配置文件、即时生效、接口、来源校验、密钥不外泄
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST, PUT } from "@/app/api/settings/model/route";
import { availableModels } from "@/lib/models/catalog";
import { modelConfigPath, readModelConfig } from "@/lib/models/config-store";
import { getProvider, redactSecrets } from "@/lib/models/openai-compatible";

const dir = mkdtempSync(join(tmpdir(), "studio-model-settings-"));
const KEY = "sk-secret-abcdef-1234567890";
const ENV_KEYS = ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const LOCAL = "http://127.0.0.1:3000";

function req(method: string, body?: unknown, headers: Record<string, string> = { origin: LOCAL, host: "127.0.0.1:3000" }) {
  return new Request(`${LOCAL}/api/settings/model`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const input = { baseUrl: "https://gw.example/v1/", model: "m-new", apiKey: KEY };
/** 模拟服务商：/models 返回列表；密钥不对返回 401 */
function mockProvider(status = 200) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization;
    if (status !== 200 || !auth.includes("sk-")) return new Response("denied", { status: status === 200 ? 401 : status });
    return Response.json({ data: [{ id: "m-new" }, { id: "other" }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.STUDIO_MODEL_CONFIG_PATH = join(dir, `c-${Math.random()}.json`);
  process.env.MODEL_BASE_URL = "https://env.example/v1";
  process.env.MODEL_NAME = "env-model";
  process.env.MODEL_API_KEY = "env-key-1234567890";
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]);
  delete process.env.STUDIO_MODEL_CONFIG_PATH;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("保存后立即生效", () => {
  it("保存用设置，清除退回环境变量；文件权限 0600；密钥不外泄", async () => {
    expect(getProvider().info().model).toBe("env-model");
    mockProvider();
    const put = await PUT(req("PUT", input));
    expect(put.status).toBe(200);
    expect(getProvider().info()).toMatchObject({ model: "m-new", baseUrlHost: "gw.example", configured: true });
    expect(readModelConfig()?.baseUrl).toBe("https://gw.example/v1");
    expect(statSync(modelConfigPath()).mode & 0o777).toBe(0o600);

    const got = await (await GET()).text();
    expect(got).not.toContain(KEY);
    expect(JSON.parse(got).data).toEqual({ source: "settings", baseUrl: "https://gw.example/v1", model: "m-new", hasKey: true, keyTail: "7890" });
    expect(await put.clone().text()).not.toContain(KEY);
    expect(redactSecrets(`oops ${KEY}`)).not.toContain(KEY);

    expect((await DELETE(req("DELETE"))).status).toBe(200);
    expect(readModelConfig()).toBeNull();
    expect(getProvider().info().model).toBe("env-model");
    expect(JSON.parse(await (await GET()).text()).data.source).toBe("env");
  });

  it("保存后模型列表缓存失效，读的是新服务商", async () => {
    const f = mockProvider();
    await availableModels();
    await PUT(req("PUT", input));
    f.mockClear();
    await availableModels();
    expect(f.mock.calls[0][0]).toBe("https://gw.example/v1/models");
  });

  it("密钥不足 8 位时 keyTail 为 null", async () => {
    process.env.MODEL_API_KEY = "short";
    expect(JSON.parse(await (await GET()).text()).data).toMatchObject({ hasKey: true, keyTail: null });
  });
});

describe("连接测试与保存", () => {
  it("测试连接不落盘，并报告模型是否在列表里", async () => {
    mockProvider();
    const r = await (await POST(req("POST", input))).json();
    expect(r.data).toEqual({ ok: true, modelFound: true, modelCount: 2 });
    expect((await (await POST(req("POST", { ...input, model: "没有" }))).json()).data.modelFound).toBe(false);
    expect(readModelConfig()).toBeNull();
  });

  it("连接失败：PUT 不落盘，说明原因且不含密钥", async () => {
    mockProvider(401);
    const res = await PUT(req("PUT", input));
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain("密钥");
    expect(text).not.toContain(KEY);
    expect(readModelConfig()).toBeNull();
  });

  it("网络错误的原因里带出的密钥会被脱敏", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(`connect failed with ${KEY}`))));
    const text = await (await PUT(req("PUT", input))).text();
    expect(text).toContain("网络");
    expect(text).not.toContain(KEY);
  });

  it("apiKey 省略时沿用已保存的密钥；从没保存过则拒绝", async () => {
    const f = mockProvider();
    const { apiKey: _omit, ...noKey } = input;
    expect((await PUT(req("PUT", noKey))).status).toBe(400);
    expect(readModelConfig()).toBeNull();
    await PUT(req("PUT", input));
    f.mockClear();
    expect((await PUT(req("PUT", { ...noKey, model: "other" }))).status).toBe(200);
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(readModelConfig()).toMatchObject({ model: "other", apiKey: KEY });
  });

  it("服务地址必须是 http(s) 网址", async () => {
    mockProvider();
    expect((await PUT(req("PUT", { ...input, baseUrl: "ftp://x" }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...input, baseUrl: "不是网址" }))).status).toBe(400);
    expect(readModelConfig()).toBeNull();
  });
});

describe("来源校验", () => {
  const bad: Record<string, Record<string, string>> = {
    "缺少 Origin": { host: "127.0.0.1:3000" },
    "其他站点": { origin: "https://evil.example", host: "127.0.0.1:3000" },
    "Origin 与 Host 不一致": { origin: "http://localhost:3000", host: "127.0.0.1:3000" },
    "hostname 不是本机": { origin: "http://192.168.1.5:3000", host: "192.168.1.5:3000" },
    "Origin 无法解析": { origin: "null", host: "127.0.0.1:3000" },
  };
  for (const [name, headers] of Object.entries(bad)) {
    it(`${name}：POST / PUT / DELETE 都返回 403，配置不变`, async () => {
      const f = mockProvider();
      await PUT(req("PUT", input));
      const before = JSON.stringify(readModelConfig());
      f.mockClear();
      const h = { "content-type": "application/json", ...headers };
      for (const [m, fn] of [["POST", POST], ["PUT", PUT], ["DELETE", DELETE]] as const) {
        const r = await fn(req(m, m === "DELETE" ? undefined : { ...input, model: "hack" }, h));
        expect(r.status).toBe(403);
      }
      expect(f).not.toHaveBeenCalled();
      expect(JSON.stringify(readModelConfig())).toBe(before);
    });
  }

  it("localhost 可以；Content-Type 不是 JSON 返回 403", async () => {
    mockProvider();
    expect((await POST(req("POST", input, { origin: "http://localhost:3000", host: "localhost:3000" }))).status).toBe(200);
    expect((await POST(req("POST", input, { origin: LOCAL, host: "127.0.0.1:3000", "content-type": "text/plain" }))).status).toBe(403);
  });
});

describe("容错", () => {
  it("配置文件损坏：读取返回 null，退回环境变量，不崩溃", async () => {
    writeFileSync(modelConfigPath(), "{坏了");
    expect(readModelConfig()).toBeNull();
    expect(getProvider().info().model).toBe("env-model");
    expect((await GET()).status).toBe(200);
  });

  it("配置文件缺一项时不生效，退回环境变量", () => {
    writeFileSync(modelConfigPath(), JSON.stringify({ baseUrl: "https://a.example/v1", model: "", apiKey: "k" }));
    expect(getProvider().info().model).toBe("env-model");
  });
});
