import { randomUUID } from "node:crypto";
import { ConnectorError } from "@/lib/connectors/types";
import { redactSecrets } from "@/lib/models/openai-compatible";
import { RunServiceError } from "@/lib/runs/service";

// PRD §6.2：{ok:true, data, request_id} 或 {ok:false, error:{code,message,details?}, request_id}

export function ok(data: unknown, status = 200) {
  return Response.json({ ok: true, data, request_id: randomUUID() }, { status });
}

export function fail(code: string, message: string, status = 400, details?: unknown) {
  return Response.json({ ok: false, error: { code, message: redactSecrets(message), details }, request_id: randomUUID() }, { status });
}

export function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  return Promise.resolve()
    .then(fn)
    .catch((e: unknown) => {
      if (e instanceof RunServiceError) return fail(e.code, e.message, e.httpStatus);
      if (e instanceof ConnectorError) {
        const status = { FORBIDDEN: 403, NOT_FOUND: 404, CONNECTOR_UNAVAILABLE: 503, BAD_REQUEST: 400 }[e.code];
        return fail(e.code, e.message, status);
      }
      console.error(e);
      return fail("INTERNAL_ERROR", e instanceof Error ? e.message : String(e), 500);
    });
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new RunServiceError("BAD_JSON_BODY", "请求体不是合法 JSON");
  }
}
