import type { PromptKind, Run } from "@/lib/contracts/run";
import type { InputSnapshot } from "@/lib/contracts/snapshot";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { newId } from "@/lib/hash";
import { db } from "@/lib/repositories/db";
import { getDataset, insertDataset, listDatasets, SPLITS, type Dataset, type DatasetSample, type FrozenAnnotation, type Split } from "@/lib/repositories/datasets";
import { annotationsForSample } from "@/lib/repositories/experiments";
import { getPrompt } from "@/lib/repositories/prompts";
import { getSnapshot } from "@/lib/repositories/snapshots";
import { RunServiceError } from "@/lib/runs/service";

// 数据集与标准答案（v1.3 §6.3）：
// - 样本分 dev（Agent 可以迭代）/ regression（受控回归）/ holdout（保留评估，Agent 看不到答案）；
// - 每个版本冻结当时样本上的人工标注，作为这个版本的标准答案（gold_version = 数据集@版本）；
// - 改样本或改标注后要用新答案，就新建一个版本；旧版本永远不变，用它评过的结果可以复现。

const fail = (code: string, message: string, status = 400): never => {
  throw new RunServiceError(code, message, status);
};

/** 样本 ID → 输入快照：输入快照 ID（snap_…）或带请求的样本（如 v3/SC-08/P1） */
export function resolveSample(prompt: { project_id: string; prompt_kind: PromptKind }, sampleId: string): InputSnapshot {
  if (sampleId.startsWith("snap_")) return getSnapshot(sampleId) ?? fail("SNAPSHOT_NOT_FOUND", `输入快照 ${sampleId} 不存在或已删除`, 404);
  const f = getFixture(sampleId) ?? fail("SAMPLE_NOT_FOUND", `样本 ${sampleId} 不存在`, 404);
  if (f.promptKind !== prompt.prompt_kind) fail("SAMPLE_KIND_MISMATCH", `样本 ${sampleId} 是 ${f.promptKind}，与提示词 ${prompt.prompt_kind} 不符`);
  return snapshotForFixture(prompt.project_id, f) ?? fail("SAMPLE_NOT_RUNNABLE", `样本 ${sampleId} 没有请求，只能仅渲染，不能真实运行`);
}

/** 样本上当前的人工标注（含当前修订号），作为冻结副本；不带修订历史 */
function freezeAnnotations(promptId: string, snapshotId: string): FrozenAnnotation[] {
  const list = annotationsForSample(promptId, snapshotId);
  const rev = db().prepare("SELECT MAX(revision) AS n FROM annotation_revisions WHERE annotation_id = ?");
  return list.map(({ revisions: _r, ...a }) => ({ ...a, revision: (rev.get(a.annotation_id) as { n: number | null }).n ?? 1 }));
}

/**
 * 新建数据集，或给已有数据集加一个新版本（给 datasetId）。
 * 冻结此刻每个样本上的人工标注作为标准答案。
 */
export function createDatasetVersion(input: { promptId: string; datasetId?: string; name?: string; samples: { sample_id: string; split: Split }[]; note?: string | null; createdBy: string }): Dataset {
  const prompt = getPrompt(input.promptId) ?? fail("PROMPT_NOT_FOUND", "提示词不存在", 404);
  const prev = input.datasetId ? (getDataset(input.datasetId) ?? fail("DATASET_NOT_FOUND", `数据集 ${input.datasetId} 不存在`, 404)) : undefined;
  if (prev && prev.prompt_id !== prompt.prompt_id) fail("DATASET_PROMPT_MISMATCH", "数据集属于另一个提示词");
  const name = input.name?.trim() || prev?.name || fail("NAME_REQUIRED", "请给数据集起个名字");
  if (!input.samples.length) fail("NO_SAMPLES", "至少要有一个样本");
  const bad = input.samples.filter((s) => !(SPLITS as readonly string[]).includes(s.split));
  if (bad.length) fail("BAD_SPLIT", `分层只能是 ${SPLITS.join(" / ")}：${bad.map((s) => s.sample_id).join("、")}`);
  if (new Set(input.samples.map((s) => s.sample_id)).size !== input.samples.length) fail("DUPLICATE_SAMPLE", "样本重复");
  const samples: DatasetSample[] = input.samples.map((s) => {
    const snap = resolveSample(prompt, s.sample_id);
    return { sample_id: s.sample_id, split: s.split, snapshot_id: snap.snapshot_id, gold: freezeAnnotations(prompt.prompt_id, snap.snapshot_id) };
  });
  if (new Set(samples.map((s) => s.snapshot_id)).size !== samples.length) fail("DUPLICATE_SAMPLE", "有两个样本其实是同一份输入");
  const d: Dataset = {
    dataset_id: prev?.dataset_id ?? newId("ds"),
    version: (prev?.version ?? 0) + 1,
    prompt_id: prompt.prompt_id,
    project_id: prompt.project_id,
    name,
    samples,
    note: input.note?.trim() || null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  insertDataset(d);
  return d;
}

export const goldVersion = (d: Pick<Dataset, "dataset_id" | "version">) => `${d.dataset_id}@${d.version}`;

/** 「数据集@版本」或只给数据集 ID（取最新版本） */
export function datasetByRef(ref: string): Dataset {
  const m = /^(.+?)(?:@(\d+))?$/.exec(ref.trim())!;
  return getDataset(m[1], m[2] === undefined ? undefined : Number(m[2])) ?? fail("DATASET_NOT_FOUND", `数据集 ${ref} 不存在`, 404);
}

/** 某提示词下被列为 holdout 的输入快照（看每个数据集的最新版本） */
export function holdoutSnapshotIds(promptId: string): Set<string> {
  return new Set(listDatasets(promptId).flatMap((d) => d.samples.filter((s) => s.split === "holdout").map((s) => s.snapshot_id)));
}

export function isHoldoutRun(run: Pick<Run, "prompt_id" | "input_snapshot_id">): boolean {
  return !!run.input_snapshot_id && holdoutSnapshotIds(run.prompt_id).has(run.input_snapshot_id);
}

/** 给 Agent 看的标注：holdout 样本隐藏正确值与备注（含修订历史里的），只留「标了什么、对还是错」 */
export function redactForHoldout<T extends { expected_value?: string | null; note?: string | null; revisions?: { body: { expected_value?: string | null; note?: string | null } }[] }>(a: T): T {
  const hide = <B extends { expected_value?: string | null; note?: string | null }>(b: B): B => ({ ...b, expected_value: b.expected_value ? "（holdout 样本，已隐藏）" : b.expected_value, note: b.note ? "（holdout 样本，已隐藏）" : b.note });
  return { ...hide(a), revisions: a.revisions?.map((r) => ({ ...r, body: hide(r.body) })) };
}
