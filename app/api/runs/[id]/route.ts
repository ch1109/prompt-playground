import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api/respond";
import { getPrompt, getVersion } from "@/lib/repositories/prompts";
import { listAnnotations, getRun } from "@/lib/repositories/runs";
import { getSnapshot, snapshotDeletedAt } from "@/lib/repositories/snapshots";
import { captureQuality, diagnosticStates } from "@/lib/runs/run-evidence";
import { rendererFor } from "@/lib/runs/service";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]">) =>
  handle(async () => {
    const run = getRun((await ctx.params).id);
    if (!run) return fail("RUN_NOT_FOUND", "Run 不存在", 404);
    const snapshot = run.input_snapshot_id ? getSnapshot(run.input_snapshot_id) : undefined;
    const payload = (snapshot?.normalized_payload ?? {}) as Record<string, unknown>;
    return ok({
      run,
      renderer: rendererFor(run) ?? null,
      annotations: listAnnotations(run.run_id),
      prompt_version_label: run.prompt_version_id ? (getVersion(run.prompt_version_id)?.label ?? null) : null,
      snapshot_deleted_at: run.input_snapshot_id && !snapshot ? snapshotDeletedAt(run.input_snapshot_id) : null,
      // 读取时推导的采集完整度与诊断状态（不回填历史 Run）
      evidence: { capture: captureQuality(run), ...diagnosticStates(run, { activeSchemaVersion: getPrompt(run.prompt_id)?.active_schema_version, hasGold: !!payload.gold }) },
      snapshot: snapshot ? { snapshot_id: snapshot.snapshot_id, label: snapshot.label, source_type: snapshot.source_type, content_hash: snapshot.content_hash, imported_at: snapshot.imported_at, warnings: snapshot.warnings, source_ids: snapshot.source_ids } : null,
      // 请求上下文仅用于 JSON 视图中的 req: 定位
      // 优先用 Run 自带的构造输入副本（v1.3 起），快照被删除后仍可定位
      request: run.built_input ?? (payload.requests as Record<string, unknown> | undefined)?.[run.prompt_kind] ?? (payload.request_kind === run.prompt_kind ? payload.request : null),
    });
  });
