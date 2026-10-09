import { fail, handle, ok } from "@/lib/api/respond";
import { annotationsToCsv, exportAnnotations } from "@/lib/repositories/annotations-export";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";

/** 导出项目全部标注：?format=csv（默认，下载文件）或 json */
export const GET = (req: Request) =>
  handle(() => {
    const sp = new URL(req.url).searchParams;
    const project = sp.get("project") ?? DEFAULT_PROJECT_ID;
    const format = sp.get("format") ?? "csv";
    const rows = exportAnnotations(project);
    if (format === "json") return ok(rows);
    if (format !== "csv") return fail("BAD_REQUEST", "format 只能是 csv 或 json");
    return new Response(annotationsToCsv(rows), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`标注-${project}.csv`)}` },
    });
  });
