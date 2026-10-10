import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PromptKind } from "@/lib/contracts/run";

/** 样本来源性质：用于界面上明确区分，禁止把示例当真实模型调用或准确率依据 */
export type FixtureOrigin = "STRUCTURE_EXAMPLE" | "RECORDED_MODEL_OUTPUT" | "CONSTRUCTED";

export const ORIGIN_LABEL: Record<FixtureOrigin, string> = {
  STRUCTURE_EXAMPLE: "规格结构演示（非模型输出）",
  RECORDED_MODEL_OUTPUT: "真实录制模型输出（非 Gold）",
  CONSTRUCTED: "人工构造（非真实单证）",
};

export interface FixtureSummary {
  id: string;
  title: string;
  origin: FixtureOrigin;
  promptKind: PromptKind;
  group: string;
  covers?: string[];
  hasRequest: boolean;
  /** 是否带独立 Gold（人工标准答案）；录制输出永远不是 Gold */
  hasGold: boolean;
  /** 原始输出自报的 schema_version；不是 JSON 或没有时为 null */
  schemaVersion: string | null;
  /** 检索与快速筛选用的问题标签（覆盖的验收项、场景、样本号） */
  tags: string[];
  /** 详情：素材、来源、上游依赖、能否真实运行 */
  detail: {
    materials: { file_id: string; type: string | null; segments: string[] }[];
    provenance: string | null;
    upstream: string | null;
    runnable: boolean;
  };
}

export interface FixtureDetail extends Omit<FixtureSummary, "hasGold" | "schemaVersion" | "tags" | "detail"> {
  raw: string;
  request?: unknown;
  gold?: { expectedRowCount?: number };
  baseDraft?: { version: string | number; rows: Record<string, Record<string, string>> };
  provenance?: unknown;
}

const ROOT = join(process.cwd(), "fixtures");
const KIND: Record<string, PromptKind> = { P1: "JIULI_P1", P2: "JIULI_P2", P3: "JIULI_P3", P4: "JIULI_P4" };

function readJson(p: string) {
  return JSON.parse(readFileSync(p, "utf8"));
}

export function listFixtures(): FixtureDetail[] {
  const out: FixtureDetail[] = [];

  // 1) 规格包 v2.0 结构演示
  const v2 = join(ROOT, "jiuli-v2.0");
  if (existsSync(v2)) {
    for (const f of readdirSync(v2).filter((x) => x.endsWith(".json")).sort()) {
      const p = f.slice(0, 2).toUpperCase();
      out.push({
        id: `v2/${f}`,
        title: `${p} v2.0 结构示例`,
        origin: "STRUCTURE_EXAMPLE",
        promptKind: KIND[p],
        group: "规格包 v2.0",
        hasRequest: false,
        raw: readFileSync(join(v2, f), "utf8"),
      });
    }
  }

  // 2) v3.0 真实录制（request + response）
  const v3 = join(ROOT, "jiuli-v3.0");
  if (existsSync(v3)) {
    for (const sample of readdirSync(v3).sort()) {
      const dir = join(v3, sample);
      if (!statSync(dir).isDirectory()) continue;
      const provenance = existsSync(join(dir, "provenance.json")) ? readJson(join(dir, "provenance.json")) : undefined;
      for (const p of ["P1", "P2", "P3", "P4"]) {
        const resp = join(dir, `${p}-response.json`);
        if (!existsSync(resp)) continue;
        const req = join(dir, `${p}-request.json`);
        out.push({
          id: `v3/${sample}/${p}`,
          title: `${sample} · ${p}`,
          origin: "RECORDED_MODEL_OUTPUT",
          promptKind: KIND[p],
          group: `v3.0 录制 · ${sample}`,
          hasRequest: existsSync(req),
          raw: readFileSync(resp, "utf8"),
          request: existsSync(req) ? readJson(req) : undefined,
          provenance,
        });
      }
    }
  }

  // 3) 人工构造
  const cdir = join(ROOT, "constructed");
  if (existsSync(join(cdir, "manifest.json"))) {
    const manifest = readJson(join(cdir, "manifest.json")) as { items: Record<string, unknown>[] };
    for (const m of manifest.items) {
      if (m.role === "REQUEST_CONTEXT") continue;
      const file = String(m.file);
      out.push({
        id: `constructed/${file}`,
        title: String(m.title),
        origin: "CONSTRUCTED",
        promptKind: m.promptKind as PromptKind,
        group: "人工构造",
        covers: m.covers as string[] | undefined,
        hasRequest: !!m.request,
        raw: readFileSync(join(cdir, file), "utf8"),
        request: m.request ? readJson(join(cdir, String(m.request))) : undefined,
        gold: m.gold as FixtureDetail["gold"],
        baseDraft: m.baseDraft as FixtureDetail["baseDraft"],
      });
    }
  }
  return out;
}

export function getFixture(id: string): FixtureDetail | undefined {
  return listFixtures().find((f) => f.id === id);
}

const UPSTREAM: Partial<Record<PromptKind, string>> = {
  JIULI_P3: "依赖 P1 委托行与 P2 查货行（请求里已包含，不需要另跑上游）",
  JIULI_P4: "依赖已确定的 P3 MATCHED 关系与当前草稿（请求里已包含）",
};

function schemaOf(raw: string): string | null {
  try {
    const v = (JSON.parse(raw) as { schema_version?: unknown }).schema_version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function summarize(f: FixtureDetail): FixtureSummary {
  const input = ((f.request as { input?: Record<string, unknown> } | undefined)?.input ?? {}) as Record<string, unknown>;
  const files = ["materials", "files"].flatMap((k) => (Array.isArray(input[k]) ? (input[k] as Record<string, unknown>[]) : []));
  const prov = f.provenance as { model?: string; created_at?: string; scenario?: string; sample_id?: string } | undefined;
  const tags = [...(f.covers ?? []), ...(prov?.scenario ? [prov.scenario] : []), ...(prov?.sample_id ? [prov.sample_id] : [])];
  return {
    id: f.id,
    title: f.title,
    origin: f.origin,
    promptKind: f.promptKind,
    group: f.group,
    covers: f.covers,
    hasRequest: f.hasRequest,
    hasGold: !!f.gold,
    schemaVersion: schemaOf(f.raw),
    tags,
    detail: {
      materials: files.map((m) => ({ file_id: String(m.file_id ?? ""), type: typeof m.material_type === "string" ? m.material_type : null, segments: Array.isArray(m.segments) ? m.segments.map(String) : [] })),
      provenance: prov ? [prov.model && `录制模型 ${prov.model}`, prov.created_at && `录制于 ${prov.created_at.slice(0, 10)}`, prov.sample_id && `九立样本 ${prov.sample_id}`].filter(Boolean).join(" · ") : null,
      upstream: UPSTREAM[f.promptKind] ?? null,
      runnable: f.hasRequest,
    },
  };
}
