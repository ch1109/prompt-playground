import { escapeToken } from "@/lib/pipeline/json-pointer";

const MAX_DEPTH = 4;
const MAX_ARRAYS = 10;

/**
 * 找出样例里可作为「数据所在位置」的列表：根本身是列表 → path 为 ""；
 * 只沿对象往下找（最多 4 层、最多 10 个），只收非空且第一项是对象的列表。
 */
export function findArrays(doc: unknown): { path: string; count: number }[] {
  const out: { path: string; count: number }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= MAX_ARRAYS) return;
    if (Array.isArray(v)) {
      const first = v[0];
      if (v.length > 0 && first !== null && typeof first === "object") out.push({ path, count: v.length });
      return;
    }
    if (v === null || typeof v !== "object" || depth >= MAX_DEPTH) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path + "/" + escapeToken(k), depth + 1);
  };
  walk(doc, "", 0);
  return out;
}
