"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";

export function LiveContextDiagram({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}) {
  return (
    <div className="h-80 overflow-hidden rounded-lg border border-ink-200 bg-white">
      <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false}>
        <Background />
        <MiniMap pannable={false} zoomable={false} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
