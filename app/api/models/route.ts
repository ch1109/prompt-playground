import { handle, ok } from "@/lib/api/respond";
import { getProvider } from "@/lib/models/openai-compatible";

/** 只返回是否已配置及模型名，绝不返回密钥 */
export const GET = () => handle(() => ok(getProvider().info()));
