// RFC6901 JSON Pointer 工具

export function escapeToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function ptr(...tokens: (string | number)[]): string {
  return tokens.map((t) => "/" + escapeToken(t)).join("");
}

export function join(base: string, ...tokens: (string | number)[]): string {
  return base + ptr(...tokens);
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`非法 JSON Pointer: ${pointer}`);
  return pointer.slice(1).split("/").map(unescapeToken);
}

export function getByPointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  let cur: unknown = doc;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      const i = Number(token);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return { found: false };
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

/** pointer 是否是 ancestor 自身或其子孙 */
export function isWithin(pointer: string, ancestor: string): boolean {
  return pointer === ancestor || pointer.startsWith(ancestor + "/");
}
