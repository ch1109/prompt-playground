import { handle, ok } from "@/lib/api/respond";
import { availableModels } from "@/lib/models/catalog";

/** 服务商可用的对话模型（默认模型排第一）；读取失败时只返回默认模型和原因 */
export const GET = () => handle(async () => ok(await availableModels()));
