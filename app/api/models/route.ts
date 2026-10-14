import { handle, ok } from "@/lib/api/respond";
import { getProvider } from "@/lib/models/openai-compatible";

/** 只返回是否已配置、模型名与能力，绝不返回密钥；?model= 取同一服务商下另一个模型的信息 */
export const GET = (req: Request) => handle(() => ok(getProvider(new URL(req.url).searchParams.get("model")).info()));
