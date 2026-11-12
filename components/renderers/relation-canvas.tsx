"use client";
import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { RelationView } from "@/lib/contracts/view-model";
import { useStudio } from "@/lib/state/studio-store";

const KIND_STYLE = {
  SELECTED: { stroke: "#138a5e", strokeWidth: 2 },
  CANDIDATE: { stroke: "#b8740a", strokeWidth: 1.5, strokeDasharray: "6 4" },
  WEAK: { stroke: "#85847e", strokeWidth: 1, strokeDasharray: "2 4" },
} as const;
/** 关系状态（match_status，见 schemas 的 enum）；未知值原样显示 */
const STATUS_LABEL: Record<string, string> = { MATCHED: "已匹配", MULTIPLE_CANDIDATES: "多个候选", UNMATCHED: "未匹配" };

/** 关系图：nodes/edges 完全由 row_relations 构建；边连接到原始查货行。只用于观察/标注，不改九立占用与核销。 */
export function RelationCanvas({ relations, onlyFrom }: { relations: RelationView[]; onlyFrom?: string }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const rels = onlyFrom ? relations.filter((r) => r.fromId === onlyFrom) : relations;

  const { nodes, edges } = useMemo(() => {
    const from = [...new Set(rels.map((r) => r.fromId))];
    const to = [...new Set(rels.flatMap((r) => r.toIds))];
    const nodes: Node[] = [
      ...from.map((id, i) => ({
        id: `o:${id}`,
        position: { x: 0, y: i * 64 },
        data: { label: id },
        sourcePosition: "right" as never,
        targetPosition: "left" as never,
        style: { background: "#ffffff", color: "#1b1b19", border: "1px solid #1b1b19", borderRadius: 10, fontSize: 11, width: 220, fontFamily: "var(--font-mono)" },
      })),
      ...to.map((id, i) => ({
        id: `r:${id}`,
        position: { x: 420, y: i * 52 },
        data: { label: id },
        sourcePosition: "right" as never,
        targetPosition: "left" as never,
        style: { background: "#ffffff", color: "#57564f", border: "1px solid #e6e5e1", borderRadius: 10, fontSize: 11, width: 240, fontFamily: "var(--font-mono)" },
      })),
    ];
    const edges: Edge[] = rels.flatMap((r) =>
      r.toIds.map((t) => ({
        id: `${r.id}::${t}`,
        source: `o:${r.fromId}`,
        target: `r:${t}`,
        data: { relationId: r.id },
        style: { ...KIND_STYLE[r.kind ?? "SELECTED"], ...(sel.relationId === r.id ? { stroke: "#2563eb", strokeWidth: 3 } : {}) },
        label: r.kind === "SELECTED" ? (STATUS_LABEL[r.status] ?? r.status) : r.kind === "CANDIDATE" ? "候选" : "弱候选",
        labelStyle: { fill: "#57564f", fontSize: 10 },
        labelBgStyle: { fill: "#fafaf8" },
      })),
    );
    return { nodes, edges };
  }, [rels, sel.relationId]);

  if (!rels.length) return <p className="px-3 py-4 text-[12px] text-ink-400">没有可画的关系（未匹配或缺少可定位的原始行）。</p>;

  return (
    <div className="h-[420px] w-full bg-ink-850" data-region="relation-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="light"
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onEdgeClick={(_, e) => {
          const rel = rels.find((r) => r.id === (e.data as { relationId: string }).relationId);
          if (!rel) return;
          select({ relationId: rel.id, tableId: "orderRows", rowId: rel.fromId, fieldKey: "match_status", jsonPointer: rel.jsonPointer, sourceRefId: rel.sourceRefIds[0] });
          setStore("evidenceOpen", true);
        }}
        onNodeClick={(_, n) => {
          if (n.id.startsWith("o:")) select({ tableId: "orderRows", rowId: n.id.slice(2) });
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d6d5d0" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
