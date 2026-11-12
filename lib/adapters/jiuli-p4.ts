import type { ChangeView, PatchSimulation, TableColumn, TableRow, TableView } from "@/lib/contracts/view-model";
import { FIELD_LABELS, P1_VALUE_KEYS } from "@/lib/schemas/common";
import { join, ptr } from "@/lib/pipeline/json-pointer";
import { arr, display, indexEvidenceKeys, makeCell, obj, type Obj, reportKeyConflicts, resolveEvidenceKeys, STATE_LABEL, strOrUndef, VMBuilder } from "./helpers";
import type { AdapterContext, AdapterOutput, BusinessAdapter } from "./types";

const WRITE_POLICY_LABEL: Record<string, string> = { AUTO: "可自动", REVIEW_ONLY: "仅复核", LOCKED: "人工锁定", UNSPECIFIED: "未指定" };
/** 显示用：英文枚举保留（便于对照 JSON），附中文说明 */
const withLabel = (v: string, labels: Record<string, string>) => (v && labels[v] ? `${v}（${labels[v]}）` : v);

const RISK_DECISIONS = new Set(["CONFLICT", "MISSING"]);
const WRITE_DECISIONS = new Set(["FILL", "UPDATE"]);

const DECISION_COLS: TableColumn[] = [
  { key: "order_row_id", title: "委托行", fixed: true, core: true },
  { key: "field", title: "字段", fixed: true, core: true },
  { key: "current_value", title: "当前值（基准）", core: true },
  { key: "result_value", title: "模型结果值", core: true },
  { key: "decision", title: "决策", kind: "state", core: true },
  { key: "verification_status", title: "核验状态", kind: "state", core: true },
  { key: "simulated_value", title: "模拟新值（SIMULATION_ONLY）" },
];

/** 只读 Patch 模拟：只有策略允许的字段变更才给出模拟值；绝不写回任何系统 */
function simulate(opts: {
  decision: string;
  status: string;
  missingRequired: boolean;
  before: unknown;
  hasBase: boolean;
  after: unknown;
  writePolicy?: string;
  blockingIssue?: boolean;
  hasConflictValues?: boolean;
}): PatchSimulation {
  const { decision, status } = opts;
  if (!opts.hasBase) return { applicable: false, reason: "未提供基准值/基准草稿快照，只展示模型声称的结果" };
  if (decision === "KEEP" || decision === "NO_ACTION") return { applicable: false, reason: `${decision} 不改变当前值` };
  if (RISK_DECISIONS.has(decision)) return { applicable: false, reason: `${decision} 需人工处理，不进入可自动应用集合` };
  if (!WRITE_DECISIONS.has(decision)) return { applicable: false, reason: `未知决策 ${decision}，不模拟` };
  if (status !== "VERIFIED_UPDATED") return { applicable: false, reason: `核验状态 ${status} 与 ${decision} 不一致，不模拟` };
  if (opts.missingRequired) return { applicable: false, reason: "missing_required=true，不模拟" };
  if (opts.hasConflictValues) return { applicable: false, reason: "存在冲突候选值，不模拟" };
  if (opts.blockingIssue) return { applicable: false, reason: "存在 blocks_auto_write=true 的未决问题" };
  if (opts.writePolicy !== undefined && opts.writePolicy !== "AUTO") return { applicable: false, reason: `write_policy=${opts.writePolicy}，不允许自动写入` };
  if (decision === "FILL" && opts.before !== "" && opts.before !== undefined && opts.before !== null) return { applicable: false, reason: "FILL 只能补空，当前值非空" };
  return { applicable: true, simulatedValue: opts.after, reason: `${decision} 满足门控（仅内存模拟）` };
}

function decisionIssues(b: VMBuilder, rowId: string, field: string, decision: string, status: string, pointer: string, sourceRefIds: string[], reason: unknown) {
  const tableTarget = { tableId: "fieldDecisions", rowId: `${rowId}:${field}`, fieldKey: "decision", jsonPointer: pointer };
  const name = FIELD_LABELS[field] ?? field;
  if (decision === "CONFLICT" || decision === "MISSING") {
    b.issue({
      type: decision === "CONFLICT" ? "FIELD_CONFLICT" : "MISSING_REQUIRED",
      severity: "WARNING",
      summary: `${rowId} · ${name}：${decision}${reason ? " — " + display(reason) : ""}`,
      target: tableTarget,
      sourceRefIds,
      origin: "MODEL_FINDING",
    });
  } else if (status === "NO_EVIDENCE") {
    // AT12：KEEP + NO_EVIDENCE 显示"未取得证据"，不当作已验证一致
    b.issue({
      type: "NO_EVIDENCE",
      severity: "INFO",
      summary: `${rowId} · ${name}：${decision} 但未取得证据（不是"已验证一致"）`,
      target: tableTarget,
      sourceRefIds,
      origin: "RULE",
    });
  }
}

function fullDraftTable(b: VMBuilder, ctx: AdapterContext, changes: ChangeView[], claimedVersion: unknown): void {
  const base = ctx.baseDraft;
  if (!base) {
    b.out.metadata!.notes!.push("未传入完整基准草稿快照：不生成「Patch 后整行草稿」，只展示候选决策（AT15）。");
    return;
  }
  if (claimedVersion !== undefined && String(claimedVersion) !== String(base.version)) {
    b.diag("WARNING", "BASE_DRAFT_VERSION_MISMATCH", `输出 base_draft_version=${display(claimedVersion)} 与快照草稿版本 ${display(base.version)} 不一致，不生成模拟草稿`);
    b.out.metadata!.notes!.push("基准草稿版本不匹配：不生成模拟整行草稿。");
    return;
  }
  const rows: TableRow[] = Object.entries(base.rows).map(([orderId, fields]) => {
    const id = `draft:${orderId}`;
    const cells: TableRow["cells"] = { order_row_id: makeCell(id, "order_row_id", orderId, "") };
    for (const k of P1_VALUE_KEYS) {
      const ch = changes.find((c) => c.rowId === orderId && c.field === k && c.simulation?.applicable);
      cells[k] = makeCell(id, k, ch ? ch.simulation!.simulatedValue : fields[k], ch ? ch.jsonPointer : "", ch?.sourceRefIds ?? []);
    }
    return { id, cells, meta: { simulation: true } };
  });
  b.out.tables.push({
    id: "simulatedDraft",
    title: "Patch 后整行草稿（SIMULATION_ONLY，仅内存，不写回）",
    columns: [{ key: "order_row_id", title: "委托行", fixed: true }, ...P1_VALUE_KEYS.map((k) => ({ key: k, title: FIELD_LABELS[k] }))],
    rows,
  });
}

/**
 * 委托行 × 25 字段矩阵：每格显示本轮决策与结果值。
 * 未在 evaluated_fields 中的字段显示「本轮未核验」——契约规定请求只带受影响字段，不能把缺席当作空值。
 */
function fieldMatrix(targets: Map<string, { row: Obj; pointer: string }>, changes: ChangeView[], patches: unknown[]): TableView {
  const orderIds = [...new Set([...targets.keys(), ...patches.map((p) => strOrUndef(obj(p).order_row_id)).filter((x): x is string => !!x)])];
  const rows: TableRow[] = orderIds.map((orderId) => {
    const id = `matrix:${orderId}`;
    const t = targets.get(orderId);
    const fields = obj(t?.row.fields);
    const cells: TableRow["cells"] = { order_row_id: makeCell(id, "order_row_id", orderId, t ? "req:" + join(t.pointer, "order_row_id") : "") };
    let locked = 0;
    for (const k of P1_VALUE_KEYS) {
      const ch = changes.find((c) => c.rowId === orderId && c.field === k);
      const rf = obj(fields[k]);
      const lock = rf.write_policy === "LOCKED";
      if (lock) locked++;
      const tag = lock ? "【锁定】" : "";
      if (ch) cells[k] = makeCell(id, k, `${tag}${STATE_LABEL[ch.action] ?? ch.action}：${display(ch.after) || "（空）"}`, ch.jsonPointer, ch.sourceRefIds);
      else if (Object.prototype.hasOwnProperty.call(fields, k)) cells[k] = makeCell(id, k, `${tag}本轮未核验（当前 ${display(rf.current_value) || "空"}）`, "req:" + join(t!.pointer, "fields", k));
      else cells[k] = makeCell(id, k, "本轮未核验", t ? "req:" + join(t.pointer, "fields") : "");
    }
    return { id, cells, meta: { locked } };
  });
  return {
    id: "fieldMatrix",
    title: "委托行 × 25 字段（本轮决策一览）",
    columns: [{ key: "order_row_id", title: "委托行", fixed: true }, ...P1_VALUE_KEYS.map((k) => ({ key: k, title: FIELD_LABELS[k] }))],
    rows,
  };
}

function summary(b: VMBuilder, out: Obj, changes: ChangeView[]): AdapterOutput["metadata"] {
  const by = (d: string) => changes.filter((c) => c.action === d).length;
  return {
    summary: [
      { label: "处理状态", value: display(out.processing_status) || "—" },
      { label: "字段决策", value: changes.length },
      { label: "保持", value: by("KEEP") },
      { label: "补空 / 更新", value: by("FILL") + by("UPDATE") },
      { label: "冲突 / 缺失", value: by("CONFLICT") + by("MISSING") },
      { label: "可模拟应用", value: changes.filter((c) => c.simulation?.applicable).length },
    ],
    notes: ["「模拟新值」只在浏览器内存中模拟（SIMULATION_ONLY），禁止写回九立。"],
  };
}

// ---------------- v3：row_patches[{evaluated_fields, field_decisions[]}]；当前值来自 request.input.target_rows ----------------

export const jiuliP4V3: BusinessAdapter = {
  adapterId: "jiuli-p4-v3",
  // 1.1.0：中文标签、锁定标识、精确指针、委托行 × 25 字段矩阵
  adapterVersion: "1.1.0",
  promptKind: "JIULI_P4",
  schemaVersion: "jiuli-ai-v3",
  rendererId: "jiuli-p4-v3",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rowsOut: TableRow[] = [];
    const changes: ChangeView[] = [];

    if (!ctx.request) b.diag("WARNING", "NO_REQUEST_CONTEXT", "未关联输入快照（P4 request）：当前值、写入策略和证据无法解析，不做 Patch 模拟。");
    const { index, conflicts } = ctx.request ? indexEvidenceKeys(ctx.request) : { index: undefined, conflicts: new Map<string, string[]>() };
    reportKeyConflicts(b, conflicts);
    const targets = new Map<string, { row: Obj; pointer: string }>();
    arr(obj(obj(ctx.request).input).target_rows).forEach((t, i) => targets.set(String(obj(t).order_row_id), { row: obj(t), pointer: ptr("input", "target_rows", i) }));

    arr(out.row_patches).forEach((p0, i) => {
      const p = obj(p0);
      const base = ptr("output", "row_patches", i);
      const orderId = strOrUndef(p.order_row_id) ?? `#${i + 1}`;
      const target = targets.get(orderId);
      if (ctx.request && !target) b.diag("WARNING", "TARGET_ROW_NOT_IN_SNAPSHOT", `委托行 ${orderId} 不在请求 target_rows 中`, join(base, "order_row_id"));
      const reqFields = obj(target?.row.fields);

      const evaluated = arr(p.evaluated_fields).map(String);
      const decided = arr(p.field_decisions).map((d) => String(obj(d).field));
      const reqEvaluated = arr(target?.row.evaluated_fields).map(String);
      if (evaluated.join("|") !== decided.join("|")) {
        b.diag("WARNING", "DECISIONS_NOT_MATCH_EVALUATED_FIELDS", `${orderId}：field_decisions 字段 [${decided.join(",")}] 与 evaluated_fields [${evaluated.join(",")}] 不一致（契约要求不多不少、顺序一致）`, base);
      }
      if (target && reqEvaluated.join("|") !== evaluated.join("|")) {
        b.diag("WARNING", "EVALUATED_FIELDS_CHANGED", `${orderId}：输出 evaluated_fields 与请求不一致`, join(base, "evaluated_fields"));
      }

      arr(p.field_decisions).forEach((d0, j) => {
        const d = obj(d0);
        const dp = join(base, "field_decisions", j);
        const field = strOrUndef(d.field) ?? "";
        if (!(P1_VALUE_KEYS as readonly string[]).includes(field)) b.diag("WARNING", "UNKNOWN_FIELD", `字段 ${field} 不在 25 列中`, join(dp, "field"));
        const rf = obj(reqFields[field]);
        const hasBase = Object.prototype.hasOwnProperty.call(rf, "current_value");
        const before = hasBase ? rf.current_value : undefined;
        const decision = strOrUndef(d.decision) ?? "";
        const status = strOrUndef(d.verification_status) ?? "";
        const evIds = resolveEvidenceKeys(b, d.evidence_keys, index, join(dp, "evidence_keys"), conflicts);
        const cands = arr(d.candidate_values);
        cands.forEach((c, k) => resolveEvidenceKeys(b, obj(c).evidence_keys, index, join(dp, "candidate_values", k, "evidence_keys"), conflicts));
        const unresolved = arr(rf.unresolved_issues).map(obj);
        const blocking = unresolved.some((x) => x.blocks_auto_write === true);
        const sim = simulate({
          decision,
          status,
          missingRequired: d.missing_required === true,
          before,
          hasBase,
          after: d.result_value,
          writePolicy: strOrUndef(rf.write_policy),
          blockingIssue: blocking,
          hasConflictValues: cands.length > 0,
        });
        const id = `${orderId}:${field}`;
        const reqField = (k: string) => (target ? "req:" + join(target.pointer, "fields", field, k) : dp);
        const change: ChangeView = {
          id,
          rowId: orderId,
          field,
          action: decision,
          before,
          after: d.result_value,
          candidate: cands.length ? cands : undefined,
          ruleId: undefined,
          verificationStatus: status,
          sourceRefIds: evIds,
          jsonPointer: dp,
          simulation: sim,
          beforeOrigin: hasBase ? `请求 target_rows.fields.${field}.current_value（来源 ${display(rf.value_origin) || "未知"}）` : "未提供基准",
        };
        changes.push(change);
        rowsOut.push({
          id,
          sourceRefIds: evIds,
          meta: { orderRowId: orderId, decision, status, locked: rf.write_policy === "LOCKED", changed: WRITE_DECISIONS.has(decision), risk: RISK_DECISIONS.has(decision) || status === "NO_EVIDENCE" || d.missing_required === true },
          cells: {
            order_row_id: makeCell(id, "order_row_id", orderId, join(base, "order_row_id")),
            field: makeCell(id, "field", FIELD_LABELS[field] ? `${FIELD_LABELS[field]}（${field}）` : field, join(dp, "field")),
            current_value: makeCell(id, "current_value", hasBase ? before : "（未提供基准）", target ? "req:" + join(target.pointer, "fields", field, "current_value") : dp, [], hasBase ? undefined : "NOT_DETECTED"),
            base_value: makeCell(id, "base_value", rf.base_value, target ? "req:" + join(target.pointer, "fields", field, "base_value") : dp),
            value_origin: makeCell(id, "value_origin", rf.value_origin, reqField("value_origin")),
            write_policy: makeCell(id, "write_policy", withLabel(strOrUndef(rf.write_policy) ?? "", WRITE_POLICY_LABEL), reqField("write_policy")),
            result_value: makeCell(id, "result_value", d.result_value, join(dp, "result_value"), evIds),
            decision: makeCell(id, "decision", withLabel(decision, STATE_LABEL), join(dp, "decision"), evIds),
            verification_status: makeCell(id, "verification_status", withLabel(status, STATE_LABEL), join(dp, "verification_status"), evIds),
            missing_required: makeCell(id, "missing_required", d.missing_required, join(dp, "missing_required")),
            candidate_values: makeCell(id, "candidate_values", cands.length ? cands.map((c) => display(obj(c).value)).join(" / ") : "", join(dp, "candidate_values")),
            referenced_issue_ids: makeCell(id, "referenced_issue_ids", arr(d.referenced_issue_ids).join(", "), join(dp, "referenced_issue_ids")),
            reason: makeCell(id, "reason", d.reason, join(dp, "reason")),
            simulated_value: makeCell(id, "simulated_value", sim.applicable ? sim.simulatedValue : `— ${sim.reason}`, dp),
          },
        });
        decisionIssues(b, orderId, field, decision, status, dp, evIds, d.reason);
      });
    });

    // ASSESS_CALCULATION 模式
    const checks = arr(out.calculation_checks);
    if (checks.length) {
      b.out.tables.push({
        id: "calculationChecks",
        title: "计算资格判断（ASSESS_CALCULATION，不含数值）",
        columns: [
          { key: "calculation_key", title: "计算键", fixed: true },
          { key: "eligible", title: "资格" },
          { key: "reason_code", title: "原因" },
          { key: "evidence_keys", title: "证据" },
        ],
        rows: checks.map((c0, i) => {
          const c = obj(c0);
          const p = ptr("output", "calculation_checks", i);
          const id = strOrUndef(c.calculation_key) ?? `calc-${i + 1}`;
          const ev = resolveEvidenceKeys(b, c.evidence_keys, index, join(p, "evidence_keys"), conflicts);
          return {
            id,
            sourceRefIds: ev,
            cells: {
              calculation_key: makeCell(id, "calculation_key", c.calculation_key, join(p, "calculation_key")),
              eligible: makeCell(id, "eligible", c.eligible, join(p, "eligible")),
              reason_code: makeCell(id, "reason_code", c.reason_code, join(p, "reason_code")),
              evidence_keys: makeCell(id, "evidence_keys", arr(c.evidence_keys).join(", "), join(p, "evidence_keys"), ev),
            },
          };
        }),
      });
    }

    arr(out.issues).forEach((x0, i) => {
      const x = obj(x0);
      b.issue({ type: strOrUndef(x.code) ?? "ISSUE", severity: "UNKNOWN", summary: display(x.message) || display(x0), target: { jsonPointer: ptr("output", "issues", i) }, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    b.out.tables.unshift({
      id: "fieldDecisions",
      title: "逐字段决策",
      columns: [
        ...DECISION_COLS.slice(0, 3),
        { key: "base_value", title: "P1 基准值" },
        { key: "value_origin", title: "值来源" },
        { key: "write_policy", title: "写入策略" },
        ...DECISION_COLS.slice(3, 6),
        { key: "missing_required", title: "必填缺失" },
        { key: "candidate_values", title: "冲突候选" },
        { key: "referenced_issue_ids", title: "引用问题" },
        { key: "reason", title: "理由", core: true },
        DECISION_COLS[6],
      ],
      rows: rowsOut,
    });
    b.out.changes = changes;
    b.out.metadata = summary(b, out, changes);
    // v3 契约没有 base_draft_version（草稿版本由系统按 request_id 绑定），这里不做版本比对
    fullDraftTable(b, ctx, changes, undefined);
    b.out.tables.push(fieldMatrix(targets, changes, arr(out.row_patches)));
    return b.out;
  },
};

// ---------------- v2.0：field_decisions 自带 current_value / rule_id / source_refs / conflict_values ----------------

export const jiuliP4V2: BusinessAdapter = {
  adapterId: "jiuli-p4-v2",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P4",
  schemaVersion: "jiuli-ai-v2",
  rendererId: "jiuli-p4",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rowsOut: TableRow[] = [];
    const changes: ChangeView[] = [];
    const claimed = out.base_draft_version;
    const versionOk = ctx.baseDraft !== undefined && String(ctx.baseDraft.version) === String(claimed);

    arr(out.row_patches).forEach((p0, i) => {
      const p = obj(p0);
      const base = ptr("output", "row_patches", i);
      const orderId = strOrUndef(p.order_row_id) ?? `#${i + 1}`;
      arr(p.field_decisions).forEach((d0, j) => {
        const d = obj(d0);
        const dp = join(base, "field_decisions", j);
        const field = strOrUndef(d.field) ?? "";
        const decision = strOrUndef(d.decision) ?? "";
        const status = strOrUndef(d.verification_status) ?? "";
        const evIds = arr(d.source_refs).map((x) => b.missingEvidence(String(x), "P4 v2 输出只含来源引用 ID，快照中未提供来源定义"));
        const conflicts = arr(d.conflict_values);
        const sim = simulate({
          decision,
          status,
          missingRequired: status === "MISSING_REQUIRED",
          before: d.current_value,
          // v2：没有与 base_draft_version 一致的基准快照时，只展示模型声称的结果
          hasBase: versionOk,
          after: d.result_value,
          hasConflictValues: conflicts.length > 0,
        });
        const id = `${orderId}:${field}`;
        changes.push({
          id,
          rowId: orderId,
          field,
          action: decision,
          before: d.current_value,
          after: d.result_value,
          candidate: conflicts.length ? conflicts : undefined,
          ruleId: strOrUndef(d.rule_id),
          verificationStatus: status,
          sourceRefIds: evIds,
          jsonPointer: dp,
          simulation: sim,
          beforeOrigin: "模型输出 current_value",
        });
        rowsOut.push({
          id,
          sourceRefIds: evIds,
          meta: { orderRowId: orderId, decision, status, changed: WRITE_DECISIONS.has(decision), risk: RISK_DECISIONS.has(decision) || status === "NO_EVIDENCE" },
          cells: {
            order_row_id: makeCell(id, "order_row_id", orderId, join(base, "order_row_id")),
            field: makeCell(id, "field", FIELD_LABELS[field] ? `${FIELD_LABELS[field]}（${field}）` : field, join(dp, "field")),
            current_value: makeCell(id, "current_value", d.current_value, join(dp, "current_value")),
            result_value: makeCell(id, "result_value", d.result_value, join(dp, "result_value"), evIds),
            decision: makeCell(id, "decision", withLabel(decision, STATE_LABEL), join(dp, "decision"), evIds),
            verification_status: makeCell(id, "verification_status", withLabel(status, STATE_LABEL), join(dp, "verification_status"), evIds),
            rule_id: makeCell(id, "rule_id", d.rule_id, join(dp, "rule_id")),
            source_refs: makeCell(id, "source_refs", arr(d.source_refs).join(", "), join(dp, "source_refs"), evIds),
            conflict_values: makeCell(id, "conflict_values", conflicts.length ? conflicts : "", join(dp, "conflict_values")),
            simulated_value: makeCell(id, "simulated_value", sim.applicable ? sim.simulatedValue : `— ${sim.reason}`, dp),
          },
        });
        decisionIssues(b, orderId, field, decision, status, dp, evIds, undefined);
      });
    });

    arr(out.warnings).forEach((w, i) => {
      b.issue({ type: "WARNING", severity: "UNKNOWN", summary: typeof w === "string" ? w : display(w), target: { jsonPointer: ptr("output", "warnings", i) }, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    b.out.tables.push({
      id: "fieldDecisions",
      title: "逐字段决策",
      columns: [
        ...DECISION_COLS.slice(0, 3),
        ...DECISION_COLS.slice(3, 6),
        { key: "rule_id", title: "规则" },
        { key: "source_refs", title: "来源" },
        { key: "conflict_values", title: "冲突值" },
        DECISION_COLS[6],
      ],
      rows: rowsOut,
    });
    b.out.tables.push({
      id: "rowVerification",
      title: "模型输出的行级核验（v2 由模型给出，非系统汇总）",
      columns: [
        { key: "order_row_id", title: "委托行", fixed: true },
        { key: "has_inspection_basis", title: "有查货依据" },
        { key: "coverage_status", title: "覆盖" },
        { key: "has_conflict", title: "有冲突" },
        { key: "has_missing_required", title: "必填缺失" },
      ],
      rows: arr(out.row_patches).map((p0, i) => {
        const p = obj(p0);
        const rv = obj(p.row_verification);
        const id = `rv:${display(p.order_row_id)}`;
        const rp = ptr("output", "row_patches", i, "row_verification");
        return {
          id,
          cells: {
            order_row_id: makeCell(id, "order_row_id", p.order_row_id, ptr("output", "row_patches", i, "order_row_id")),
            has_inspection_basis: makeCell(id, "has_inspection_basis", rv.has_inspection_basis, join(rp, "has_inspection_basis")),
            coverage_status: makeCell(id, "coverage_status", rv.coverage_status, join(rp, "coverage_status")),
            has_conflict: makeCell(id, "has_conflict", rv.has_conflict, join(rp, "has_conflict")),
            has_missing_required: makeCell(id, "has_missing_required", rv.has_missing_required, join(rp, "has_missing_required")),
          },
        };
      }),
    });
    b.out.changes = changes;
    b.out.metadata = summary(b, out, changes);
    b.out.metadata!.summary!.splice(1, 0, { label: "基准草稿版本", value: display(claimed) || "—", hint: versionOk ? "与快照一致" : "无匹配的基准快照" });
    fullDraftTable(b, ctx, changes, claimed);
    return b.out;
  },
};
