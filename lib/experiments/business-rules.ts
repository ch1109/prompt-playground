// P3 / P4 业务硬规则（v1.3 §10.3「硬性回归检查」）：只拿请求输入和模型输出对照，确定性判断，不猜。
// 规则全部出自九立 v3.0 提示词本身的约束（P3「三、1/4/6」与末尾自检清单；P4「三、2/4/5/6」与「五」字段规则）。
// 用于试运行评判：某条规则在修改后违反得比原来多 → 判为变差。

export interface RuleViolation {
  rule: string;
  /** 给人看的规则名（大白话） */
  label: string;
  message: string;
  json_pointer: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

export const RULE_LABELS: Record<string, string> = {
  P3_CROSS_CUSTOMER: "跨客户匹配",
  P3_UNKNOWN_ID: "引用了输入里没有的行",
  P3_OCCUPIED_REUSED: "复用了已被占用的查货行",
  P3_RAW_ROW_REUSED: "同一查货行分给了多个委托行",
  P3_NO_IDENTITY_EVIDENCE: "没有型号等身份证据就判定匹配（可能凭数量凑配）",
  P4_LOCKED_CHANGED: "改了人工锁定的字段",
  P4_POLICY_CHANGED: "改了只供审核 / 策略未定的字段",
  P4_BLOCKED_CHANGED: "有阻止写入的未解决问题却改了值",
  P4_TRANSACTION_CHANGED: "改了不允许由查货改的交易字段",
  P4_UPDATE_NOT_ALLOWED: "对不允许覆盖的字段用了 UPDATE",
  P4_INCOMPLETE_SCOPE_WRITE: "依据的来源范围不完整却写了值",
};

const v = (rule: string, message: string, json_pointer: string): RuleViolation => ({ rule, label: RULE_LABELS[rule], message, json_pointer });

/** 能证明「是同一件商品」的证据字段；数量、PO、产地、顺序等不能单独证明（P3「三、4」） */
const IDENTITY_FIELDS = new Set(["model", "business_row_marker", "material_no", "sku", "lot", "dc"]);

export function p3Violations(request: unknown, parsed: unknown): RuleViolation[] {
  const input = obj(obj(request).input);
  const out: RuleViolation[] = [];
  const orders = new Map(arr(input.order_rows).map((o) => [str(obj(o).order_row_id), obj(o)]));
  const cands = new Map(arr(input.inspection_candidates).map((c) => [str(obj(c).raw_row_id), obj(c)]));
  const evidenceField = new Map<string, string>();
  for (const x of [...orders.values(), ...cands.values()]) for (const e of arr(x.evidence)) evidenceField.set(str(obj(e).evidence_key), str(obj(e).field));
  const selectedBy = new Map<string, string[]>();

  arr(obj(obj(parsed).output).row_relations).forEach((r0, i) => {
    const r = obj(r0);
    const p = `/output/row_relations/${i}`;
    const orderId = str(r.order_row_id);
    const order = orders.get(orderId);
    if (!order) out.push(v("P3_UNKNOWN_ID", `委托行 ${orderId} 不在输入里`, `${p}/order_row_id`));
    const mentioned = [...arr(r.selected_raw_row_ids), ...arr(r.candidate_groups).flatMap((g) => arr(obj(g).raw_row_ids)), ...arr(r.weak_candidates).flatMap((g) => arr(obj(g).raw_row_ids))].map(str);
    for (const raw of new Set(mentioned)) if (raw && !cands.has(raw)) out.push(v("P3_UNKNOWN_ID", `${orderId} 引用的查货行 ${raw} 不在输入候选里`, p));
    if (r.match_status !== "MATCHED") return;
    arr(r.selected_raw_row_ids).forEach((x, k) => {
      const raw = str(x);
      const c = cands.get(raw);
      selectedBy.set(raw, [...(selectedBy.get(raw) ?? []), orderId]);
      if (!c) return;
      if (order && c.customer_id !== undefined && order.customer_id !== undefined && str(c.customer_id) !== str(order.customer_id))
        out.push(v("P3_CROSS_CUSTOMER", `${orderId}（客户 ${str(order.customer_id)}）选中了客户 ${str(c.customer_id)} 的查货行 ${raw}`, `${p}/selected_raw_row_ids/${k}`));
      const occ = c.occupied_by_order_row_id;
      if (occ !== undefined && occ !== null && str(occ) !== orderId) out.push(v("P3_OCCUPIED_REUSED", `${orderId} 选中的 ${raw} 已被 ${str(occ)} 占用`, `${p}/selected_raw_row_ids/${k}`));
    });
    const keys = [...arr(r.evidence_keys), ...arr(obj(r.coverage).evidence_keys)].map(str);
    if (!keys.some((k) => IDENTITY_FIELDS.has(evidenceField.get(k) ?? ""))) out.push(v("P3_NO_IDENTITY_EVIDENCE", `${orderId} 判定 MATCHED，但引用的证据里没有型号 / 料号等身份证据`, `${p}/evidence_keys`));
  });
  for (const [raw, ids] of selectedBy) if (ids.length > 1) out.push(v("P3_RAW_ROW_REUSED", `查货行 ${raw} 同时被 ${ids.join("、")} 选中`, "/output/row_relations"));
  return out;
}

/** 不允许由查货结果改动的交易字段（P4「五」1、5、8、20 条；非空型号见第 3 条） */
const TRANSACTION_FIELDS = new Set(["customer_name", "product_name", "quantity", "purchase_order_no"]);
/** 只有这几个字段允许 UPDATE（P4「四」UPDATE 条） */
const UPDATABLE = new Set(["origin", "net_weight", "gross_weight"]);

export function p4Violations(request: unknown, parsed: unknown): RuleViolation[] {
  const out: RuleViolation[] = [];
  const rows = new Map(arr(obj(obj(request).input).target_rows).map((t) => [str(obj(t).order_row_id), obj(obj(t).fields)]));
  arr(obj(obj(parsed).output).row_patches).forEach((p0, i) => {
    const patch = obj(p0);
    const orderId = str(patch.order_row_id);
    const fields = rows.get(orderId) ?? {};
    arr(patch.field_decisions).forEach((d0, j) => {
      const d = obj(d0);
      const name = str(d.field);
      const f = obj(fields[name]);
      // 指向被改动的结果值，页面上能直接定位到那一格
      const ptr = `/output/row_patches/${i}/field_decisions/${j}/result_value`;
      if (!fields[name]) return;
      const current = str(f.current_value);
      const changed = d.result_value !== undefined && str(d.result_value) !== current;
      const writes = changed || d.decision === "FILL" || d.decision === "UPDATE";
      const where = `${orderId} 的 ${name}`;
      if (!writes) return;
      const desc = `「${current || "空"}」→「${str(d.result_value) || "空"}」（${str(d.decision)}）`;
      if (f.write_policy === "LOCKED") out.push(v("P4_LOCKED_CHANGED", `${where} 已锁定，却被改为 ${desc}`, ptr));
      if (f.write_policy === "REVIEW_ONLY" || f.write_policy === "UNSPECIFIED") out.push(v("P4_POLICY_CHANGED", `${where} 写入策略是 ${str(f.write_policy)}，却被改为 ${desc}`, ptr));
      if (arr(f.unresolved_issues).some((x) => obj(x).blocks_auto_write === true)) out.push(v("P4_BLOCKED_CHANGED", `${where} 有阻止自动写入的问题，却被改为 ${desc}`, ptr));
      if (TRANSACTION_FIELDS.has(name) || (name === "model" && current)) out.push(v("P4_TRANSACTION_CHANGED", `${where} 是交易字段，不能由查货改动，却被改为 ${desc}`, ptr));
      if (d.decision === "UPDATE" && !UPDATABLE.has(name)) out.push(v("P4_UPDATE_NOT_ALLOWED", `${where} 不允许 UPDATE，却被改为 ${desc}`, ptr));
      // 写值依据的来源范围必须完整：COMPLETE、DISJOINT、没有额外或未定商品（P4「二」第 30 行）
      const evidence = new Map(arr(f.evidence).map((e) => [str(obj(e).evidence_key), obj(obj(e).scope)]));
      const cited = arr(d.evidence_keys).map(str).filter((k) => evidence.has(k));
      const complete = (s: Obj) => s.coverage === "COMPLETE" && s.overlap === "DISJOINT" && s.has_extra_goods !== true && s.has_unresolved_goods !== true;
      if ((d.decision === "FILL" || d.decision === "UPDATE") && (!cited.length || cited.some((k) => !complete(evidence.get(k)!))))
        out.push(v("P4_INCOMPLETE_SCOPE_WRITE", `${where} 被改为 ${desc}，但${cited.length ? "依据的来源范围不完整" : "没有引用任何输入证据"}`, ptr));
    });
  });
  return out;
}

/** 某个阶段会检查哪些规则（给页面列出规则名）；没有规则的阶段返回空数组 */
export function rulesFor(kind: string): string[] {
  const prefix = kind === "JIULI_P3" ? "P3_" : kind === "JIULI_P4" ? "P4_" : null;
  return prefix ? Object.entries(RULE_LABELS).filter(([k]) => k.startsWith(prefix)).map(([, label]) => label) : [];
}

export function businessViolations(kind: string, request: unknown, parsed: unknown): RuleViolation[] | null {
  if (parsed === undefined || request === null || request === undefined) return null;
  if (kind === "JIULI_P3") return p3Violations(request, parsed);
  if (kind === "JIULI_P4") return p4Violations(request, parsed);
  return null;
}
