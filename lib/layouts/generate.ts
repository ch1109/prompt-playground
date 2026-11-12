// 让 AI 根据提示词和一次真实输出生成版式。只生成、不保存；保存由用户确认后走 PUT /api/prompts/[id]/layout。
import { parseRawResponse } from "@/lib/pipeline/parse";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { explainModelError } from "@/lib/models/error-hints";
import { getProvider, redactSecrets } from "@/lib/models/openai-compatible";
import { applyLayout } from "./apply";
import { validateLayout, type Layout } from "./types";

export type WantKind = "table" | "cards" | "checklist" | "report";
export const SAMPLE_MAX_CHARS = 6000;
export const PROMPT_MAX_CHARS = 4000;

/** 逐步收紧「每个数组保留几项 / 单个文字最长几个字」，直到序列化后不超过上限；仍超出则硬截断 */
export function truncateSample(sample: unknown, max = SAMPLE_MAX_CHARS): { text: string; truncated: boolean } {
  const full = JSON.stringify(sample) ?? "null";
  if (full.length <= max) return { text: full, truncated: false };
  const shrink = (v: unknown, arr: number, str: number): unknown => {
    if (typeof v === "string") return v.length > str ? v.slice(0, str) + "…" : v;
    if (Array.isArray(v)) return v.slice(0, arr).map((x) => shrink(x, arr, str));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, arr, str)]));
    return v;
  };
  for (const [arr, str] of [[20, 300], [10, 200], [5, 150], [3, 100], [2, 60]]) {
    const text = JSON.stringify(shrink(sample, arr, str));
    if (text.length <= max) return { text, truncated: true };
  }
  return { text: JSON.stringify(shrink(sample, 2, 40)).slice(0, max), truncated: true };
}

const SYSTEM = `你是「版式设计助手」。任务：根据提示词原文和一次真实的 JSON 输出样例，写出一个「版式」JSON，决定这类输出在界面上怎么显示。

只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块以外的文字。版式只含 JSON Pointer 路径和显示名，不含代码或表达式。

路径约定（RFC6901）：
- itemsPath：指向「数组」的绝对路径，如 "/items"；样例的根本身就是数组时写空串 ""。
- 其余 path（columns / fields / titlePath 等）：相对「数组里每一项」的路径，如 "/name"；空串 "" 表示这一项本身。
- report 的 sections[].path 是绝对路径。
- 所有 path 必须来自样例里真实存在的位置，不得臆造字段名。label / title 用简短中文，不超过 40 字。
- 所有版式都必须带 "version": 1，可选 "title"（版式名称）。

四种 kind：
1. table（一行一条记录，适合记录列表）：
{"version":1,"kind":"table","itemsPath":"/items","columns":[{"label":"名称","path":"/name"},{"label":"数量","path":"/qty","kind":"number"}]}
   列的 kind 可选 text / number / state。
2. cards（每条一张卡片，适合字段较多的对象列表）：
{"version":1,"kind":"cards","itemsPath":"/items","titlePath":"/name","badgePath":"/status","fields":[{"label":"说明","path":"/desc"}]}
   badgePath 可省略。
3. checklist（逐项检查，通过/未通过 + 严重度）：
{"version":1,"kind":"checklist","itemsPath":"/checks","titlePath":"/rule","statusPath":"/result","passValues":["通过","pass"],"severityPath":"/level","detailPath":"/reason"}
   statusPath / passValues / severityPath / detailPath 都可省略。
4. report（按章节排版的长文，值可为文字、数组或对象）：
{"version":1,"kind":"report","sections":[{"title":"摘要","path":"/summary"},{"title":"风险","path":"/risks"}]}

选择建议：有一个对象数组且字段简单 → table；字段多或每条内容长 → cards；每条是检查项/规则判断 → checklist；以多段文字为主、没有明显的记录列表 → report。`;

const WANT_TEXT: Record<WantKind, string> = {
  table: "表格（table）",
  cards: "卡片（cards）",
  checklist: "检查清单（checklist）",
  report: "报告（report）",
};

function buildUser(promptText: string, sample: unknown, want: WantKind | undefined, feedback?: { prev: string; errors: string[] }): string {
  const p = promptText.length > PROMPT_MAX_CHARS ? promptText.slice(0, PROMPT_MAX_CHARS) + "\n……（提示词已截断）" : promptText;
  const s = truncateSample(sample);
  const parts = [
    `【提示词原文】\n${p}`,
    `【这次运行的 JSON 输出样例${s.truncated ? "（已截断：数组只保留了前几项，文字过长处已缩短，实际数据更多）" : ""}】\n${s.text}`,
    want ? `【用户指定的形态】${WANT_TEXT[want]}，请使用这个 kind。` : "【形态】用户没有指定，请自己选最合适的一种。",
  ];
  if (feedback) parts.push(`【上一次你的输出】\n${feedback.prev.slice(0, 2000)}\n\n【它的问题】\n${feedback.errors.map((e) => `- ${e}`).join("\n")}\n\n请修正后重新输出一个完整的版式 JSON。`);
  return parts.join("\n\n");
}

/** 解析 → 校验 → 套用样例；失败返回中文原因 */
function check(raw: string, sample: unknown, want: WantKind | undefined): { layout: Layout } | { errors: string[] } {
  const parsed = parseRawResponse(raw);
  if (!parsed.ok) return { errors: ["你的输出不是一个合法的 JSON 对象（不要夹杂说明文字）"] };
  const v = validateLayout(parsed.value);
  if (!v.ok) return { errors: v.errors };
  const layout = v.layout;
  if (want && layout.kind !== want) return { errors: [`用户要求 ${want}，但你输出的 kind 是 ${layout.kind}`] };
  const r = applyLayout(layout, sample);
  if (r.kind === "mismatch") return { errors: [r.reason] };
  if (layout.kind !== "report") {
    const items = getByPointer(sample, layout.itemsPath);
    const sampleEmpty = items.found && Array.isArray(items.value) && items.value.length === 0;
    if (!sampleEmpty) {
      const n = r.kind === "table" ? r.table.rows.length : r.kind === "cards" ? r.cards.length : r.kind === "checklist" ? r.issues.length : 0;
      if (n === 0) return { errors: ["套用到样例后一条记录都没有，请检查 itemsPath 是否指向样例里真实的数组"] };
    }
  }
  return { layout };
}

export async function generateLayout(input: { promptText: string; sample: unknown; want?: WantKind; model?: string | null }): Promise<{ ok: true; layout: Layout } | { ok: false; message: string }> {
  const provider = getProvider(input.model);
  let feedback: { prev: string; errors: string[] } | undefined;
  let lastErrors: string[] = [];
  for (let round = 0; round < 2; round++) {
    const res = await provider.complete({ system: SYSTEM, user: buildUser(input.promptText, input.sample, input.want, feedback), params: { temperature: 0, max_tokens: 2000 } });
    if (!res.ok) {
      const h = explainModelError(res.code);
      return { ok: false, message: redactSecrets(`${h.title}。${h.advice}`) };
    }
    const c = check(res.raw, input.sample, input.want);
    if ("layout" in c) return { ok: true, layout: c.layout };
    lastErrors = c.errors;
    feedback = { prev: res.raw, errors: c.errors };
  }
  return { ok: false, message: `AI 两次都没能生成可用的版式（${lastErrors.join("；")}）。可以换个形态再试，或稍后重试。` };
}
