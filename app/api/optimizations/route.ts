import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { createSession, sessionView } from "@/lib/optimization/service";
import { listSessions } from "@/lib/repositories/optimizations";

// 自动优化会话（v1.3 §11、§12.3 POST /api/optimizations）：列出某提示词的会话；从标了「错」的字段开始一次自动优化。

export const GET = (req: NextRequest) =>
  handle(() => {
    const promptId = req.nextUrl.searchParams.get("promptId");
    if (!promptId) return fail("BAD_REQUEST", "缺少 promptId");
    return ok(listSessions(promptId).map((s) => sessionView(s.session_id)));
  });

export const POST = (req: NextRequest) =>
  handle(async () => {
    const b = await body<{ runId?: string; jsonPointer?: string; regressionSamples?: string[]; maxModelRuns?: number; maxIterations?: number }>(req);
    if (!b.runId || !b.jsonPointer || !Array.isArray(b.regressionSamples)) return fail("BAD_REQUEST", "需要 runId、jsonPointer 与 regressionSamples");
    const s = createSession({ runId: b.runId, jsonPointer: b.jsonPointer, regressionSamples: b.regressionSamples, maxModelRuns: Number(b.maxModelRuns), maxIterations: b.maxIterations === undefined ? undefined : Number(b.maxIterations), createdBy: process.env.STUDIO_USER || "本机用户" });
    return ok(sessionView(s.session_id), 201);
  });
