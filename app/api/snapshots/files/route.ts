import { fail, handle, ok } from "@/lib/api/respond";
import { createFileSnapshot, UPLOAD_MATERIAL_TYPES, UploadError, type UploadMaterialType } from "@/lib/materials/store";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";

/**
 * 上传原件创建 FILE_IMPORT 快照（multipart）：files（多个）与 types（与 files 一一对应的材料类型），
 * 可选 projectId / label / customerName。只写 Studio 私有存储。
 */
export const POST = (req: Request) =>
  handle(async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("BAD_REQUEST", "请求必须是 multipart/form-data");
    }
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    const types = form.getAll("types").map(String);
    if (!files.length) return fail("BAD_REQUEST", "请至少选择一个文件");
    if (types.length !== files.length || !types.every((t) => (UPLOAD_MATERIAL_TYPES as readonly string[]).includes(t))) {
      return fail("BAD_REQUEST", `每个文件都要指定材料类型：${UPLOAD_MATERIAL_TYPES.join(" / ")}`);
    }
    try {
      const snap = await createFileSnapshot({
        projectId: String(form.get("projectId") ?? "") || DEFAULT_PROJECT_ID,
        label: String(form.get("label") ?? ""),
        customerName: String(form.get("customerName") ?? ""),
        files: await Promise.all(files.map(async (f, i) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()), materialType: types[i] as UploadMaterialType }))),
      });
      return ok(snap, 201);
    } catch (e) {
      if (e instanceof UploadError) return fail("UPLOAD_REJECTED", e.message);
      throw e;
    }
  });
