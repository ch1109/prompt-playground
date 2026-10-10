// 上传原件的辅助规则（浏览器与服务端共用，不依赖 Node）：按文件名猜材料类型、判断是否跳过。

export const UPLOAD_EXTS = [".pdf", ".xlsx", ".xls", ".png", ".jpg", ".jpeg"];

export type GuessKind = "JIULI_P1" | "JIULI_P2" | "JIULI_P3" | "JIULI_P4" | "GENERIC_JSON";

const RULES: [RegExp, "ORDER" | "INVOICE" | "PACKING_LIST" | "INSPECTION"][] = [
  [/查货|验货|inspection|qc/i, "INSPECTION"],
  [/箱单|装箱|packing|(^|[^a-z])pl([^a-z]|$)/i, "PACKING_LIST"],
  [/发票|invoice|(^|[^a-z])inv([^a-z]|$)|(^|[^a-z])ci([^a-z]|$)/i, "INVOICE"],
  [/委托|订单|order|(^|[^a-z])po([^a-z]|$)/i, "ORDER"],
];

/** 按文件名（含子文件夹路径）猜材料类型；猜不出时 P2 记为查货文件，其余记为委托单 */
export function guessMaterialType(path: string, kind?: GuessKind): "ORDER" | "INVOICE" | "PACKING_LIST" | "INSPECTION" {
  const name = path.split("/").pop() ?? path;
  for (const [re, t] of RULES) if (re.test(name)) return t;
  for (const [re, t] of RULES) if (re.test(path)) return t;
  return kind === "JIULI_P2" ? "INSPECTION" : "ORDER";
}

/** 文件夹里应跳过的文件：隐藏文件、系统文件、不支持的格式；返回原因，可用时返回 null */
export function skipReason(path: string): string | null {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((p) => p.startsWith(".") || p === "__MACOSX") || name === "Thumbs.db" || name.startsWith("~$")) return "隐藏 / 系统文件";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (!UPLOAD_EXTS.includes(ext)) return `不支持的格式${ext ? ` ${ext}` : "（无扩展名）"}`;
  return null;
}
