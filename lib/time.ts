/**
 * 数据库里的时间都是 UTC 的 ISO 字符串（结尾 Z）。界面和提示语一律按本机时区显示。
 * 返回「YYYY-MM-DD HH:mm:ss」，调用处按需截取，例如 .slice(5, 16) 得「MM-DD HH:mm」。
 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
