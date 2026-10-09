import { handle, ok } from "@/lib/api/respond";
import { usableKinds } from "@/lib/input-builders";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { getSnapshot, listSnapshots } from "@/lib/repositories/snapshots";

/** 快照列表，附带可用于哪些 Prompt（usable_kinds）与外部来源 ID（刷新时用） */
export const GET = (req: Request) =>
  handle(() =>
    ok(
      listSnapshots(new URL(req.url).searchParams.get("project") ?? DEFAULT_PROJECT_ID).map((row) => {
        const snap = getSnapshot(String(row.snapshot_id))!;
        return { ...row, usable_kinds: usableKinds(snap), source_ids: snap.source_ids };
      }),
    ),
  );
