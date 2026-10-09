import { body, fail, handle, ok } from "@/lib/api/respond";
import { createProject, listProjects, type ProjectTemplate } from "@/lib/repositories/prompts";

export const GET = () => handle(() => ok(listProjects()));

/** 新建项目：{name, template: "JIULI" | "BLANK"} */
export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ name?: string; description?: string; template?: ProjectTemplate }>(req);
    if (!b.name?.trim()) return fail("BAD_REQUEST", "项目名称不能为空");
    if (b.template !== "JIULI" && b.template !== "BLANK") return fail("BAD_REQUEST", "template 只能是 JIULI 或 BLANK");
    return ok(createProject({ name: b.name, description: b.description, template: b.template }), 201);
  });
