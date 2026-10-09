import type { ParseResult } from "@/lib/contracts/run";

// 只接受"完整 JSON"。唯一例外：整段回复恰好是一个 ```json 围栏代码块，
// 这时做显式、可追溯的提取，并记录诊断。不会从夹杂说明文字的 Markdown 中猜 JSON。
const FENCE = /^```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

function lineCol(text: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

function errorOffset(message: string, text: string): number | undefined {
  const m = /position (\d+)/.exec(message);
  if (m) return Number(m[1]);
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) {
    const lines = text.split("\n");
    let off = 0;
    for (let i = 0; i < Number(lc[1]) - 1 && i < lines.length; i++) off += lines[i].length + 1;
    return off + Number(lc[2]) - 1;
  }
  if (/Unexpected end of JSON input/.test(message)) return text.length;
  return undefined;
}

export function parseRawResponse(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      diagnostics: [{ phase: "PARSE", level: "ERROR", code: "EMPTY_RESPONSE", message: "原始回复为空" }],
    };
  }

  let text = trimmed;
  let extraction: "RAW" | "FENCED" = "RAW";
  const diagnostics: ParseResult["diagnostics"] = [];
  const fence = FENCE.exec(trimmed);
  if (fence) {
    text = fence[1];
    extraction = "FENCED";
    diagnostics.push({
      phase: "PARSE",
      level: "WARNING",
      code: "FENCED_JSON_EXTRACTED",
      message: "原始回复是一个完整的 ```json 代码块，已显式提取其中内容解析（原文未修改）。",
    });
  }

  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object") {
      return {
        ok: false,
        extraction,
        diagnostics: [
          ...diagnostics,
          { phase: "PARSE", level: "ERROR", code: "NOT_JSON_OBJECT", message: "回复是合法 JSON 但不是对象或数组" },
        ],
      };
    }
    return { ok: true, value, extraction, diagnostics };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const local = errorOffset(message, text);
    // 位置换算回原始文本（围栏提取时加上围栏前缀长度）
    const base = extraction === "FENCED" ? raw.indexOf(text) : raw.indexOf(trimmed);
    const offset = local === undefined ? undefined : Math.max(0, base) + local;
    const pos = offset === undefined ? undefined : { offset, ...lineCol(raw, offset) };
    const looksLikeProse = !/^[[{]/.test(text);
    diagnostics.push({
      phase: "PARSE",
      level: "ERROR",
      code: looksLikeProse ? "NOT_PURE_JSON" : "INVALID_JSON",
      message:
        (looksLikeProse ? "回复不是纯 JSON（含说明文字或 Markdown），不做猜测提取。" : "JSON 语法错误。") +
        ` 解析器信息：${message}` +
        (pos ? `（第 ${pos.line} 行第 ${pos.column} 列）` : ""),
    });
    return { ok: false, extraction, diagnostics, errorPosition: pos };
  }
}
