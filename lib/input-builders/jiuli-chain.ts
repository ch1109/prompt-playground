/**
 * 九立 P1→P2→P3→P4 链路：用上游运行的 v15 输出拼下游请求。
 * 规则与 2026-11-16 真实材料测试时用的拼装脚本一致（见 docs/v5.3提示词真实材料测试_2026-11-16.md）：
 * - P3：委托商品行 = P1 r[]；查货商品池 = P2 各入仓号的合并商品，带稳定引用；
 * - P4：每条 P3「已匹配」的委托行一份，只带 P3 实际引用的查货商品与原始行。
 */
type Rec = Record<string, unknown>;

const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

/** 是 v15 输出且带有指定数组（P1/P3 是 r，P2 是 h） */
export function isV15(x: unknown, key: "r" | "h"): x is Rec {
  return !!x && typeof x === "object" && (x as Rec).v === 15 && Array.isArray((x as Rec)[key]);
}

/** P2 输出 → 查货商品池：合并商品引用「W-入仓号-G商品号」，原始行引用「P-入仓号-商品号-行号」；scopes 为各入仓号的合计、共享值与问题 */
export function inspectionPool(p2: Rec): { items: Rec[]; scopes: Rec[] } {
  const items: Rec[] = [];
  const scopes: Rec[] = [];
  arr(p2.h).forEach((h, hi) => {
    const wh = (h.wh as string) || `未知入仓号${hi + 1}`;
    scopes.push({ wh, tot: h.tot, qc: h.qc, g: h.g ?? [], issues: h.issues ?? [] });
    for (const r of arr(h.r)) {
      const { parts, id, ...rest } = r;
      items.push({ ref: `W-${wh}-G${id}`, wh, ...rest, parts: arr(parts).map((p) => ({ ...p, ref: `P-${wh}-${id}-${p.n}` })) });
    }
  });
  return { items, scopes };
}

export function p3Request(p1: Rec, p2: Rec): Rec {
  return {
    说明: "委托商品行来自 P1 识别结果（尚无人工修订）；查货商品池来自同一客户本批 P2 识别结果。ref / parts[].ref 为本次上下文给出的真实标识。",
    委托商品行: arr(p1.r),
    委托共享值: arr(p1.g),
    查货商品池: inspectionPool(p2).items,
    已确认关系: [],
    人工修订: [],
  };
}

/** P3 结果里「已匹配」且能在 P1 找到的委托行 */
export function matchedRows(p1: Rec, p3: Rec): { row: Rec; rel: Rec }[] {
  const rows = new Map(arr(p1.r).map((r) => [r.id, r]));
  return arr(p3.r)
    .filter((rel) => rel.st === "MATCHED" && rows.has(rel.id))
    .map((rel) => ({ row: rows.get(rel.id)!, rel }));
}

export function p4Request(p1: Rec, p2: Rec, row: Rec, rel: Rec): Rec {
  const { items, scopes } = inspectionPool(p2);
  const refs = new Set(arr(rel.m).map((m) => m.ref));
  const partRefs = new Set(arr(rel.m).flatMap((m) => (Array.isArray(m.parts) ? (m.parts as string[]) : [])));
  const matched = items
    .filter((it) => refs.has(it.ref))
    .map((it): Rec => ({ ...it, parts: arr(it.parts).filter((p) => !partRefs.size || partRefs.has(p.ref as string)) }));
  const whs = new Set(matched.map((it) => it.wh));
  return {
    说明: "本次核对一条委托行。current 为当前有效委托行（P1 识别值，无人工修订）；manual 为人工锁定（无）；查货事实只含 P3 实际匹配的查货商品与原始行。",
    current: row,
    manual: {},
    委托共享值: arr(p1.g).filter((g) => Array.isArray(g.r) && (g.r as unknown[]).includes(row.id)),
    委托合计: p1.tot,
    委托抬头问题: ((p1.h as Rec | undefined)?.issues as unknown[] | undefined) ?? [],
    P3关系: rel,
    查货匹配商品: matched,
    查货入仓号范围: scopes.filter((s) => whs.has(s.wh)),
  };
}
