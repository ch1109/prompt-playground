import { join } from "node:path";

/** 上传原件的私有存储目录（按内容 sha256 命名，不使用用户提供的文件名） */
export function materialsDir() {
  return process.env.STUDIO_MATERIALS_DIR ?? join(process.cwd(), "data", "materials");
}

/** authorized_file_ref 形如 upload:<sha256><.ext>；只接受这种格式，杜绝路径穿越 */
export const UPLOAD_REF = /^upload:([0-9a-f]{64}\.(pdf|xlsx|xls|png|jpg|jpeg))$/;

export function uploadedPath(ref: string): string | undefined {
  const m = UPLOAD_REF.exec(ref);
  return m ? join(materialsDir(), m[1]) : undefined;
}
