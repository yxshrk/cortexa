"use client";

import type { Edge, Node } from "@xyflow/react";
import { LiveContextDiagram } from "./LiveContextDiagram";
import type { ProjectContextItem } from "@/lib/realtime";

const SOURCE_COLORS: Record<string, string> = {
  meeting: "#dbeafe",
  slack: "#f3e8ff",
  drive: "#dcfce7",
  notion: "#f1f5f9",
  gmail: "#fee2e2",
  github: "#e0e7ff",
};

function toGraph(query: string | null, items: ProjectContextItem[]): {
  nodes: Node[];
  edges: Edge[];
} {
  if (!query || items.length === 0) {
    return { nodes: [], edges: [] };
  }

  const topicNode: Node = {
    id: "topic",
    position: { x: 0, y: 100 },
    data: { label: query },
    type: "default",
    style: {
      border: "1px solid #111827",
      background: "#111827",
      color: "#ffffff",
      width: 220,
      fontSize: 12,
    },
  };

  const itemNodes = items.map((item, index): Node => ({
    id: `item-${index}`,
    position: { x: 320, y: index * 88 },
    data: {
      label: `${item.source}${item.score ? ` · ${Math.round(item.score * 100)}%` : ""}\n${
        item.title ?? item.code_path ?? item.snippet ?? "Context item"
      }`,
    },
    type: "default",
    style: {
      background: SOURCE_COLORS[item.source] ?? "#f8fafc",
      border: "1px solid #cbd5e1",
      width: 260,
      fontSize: 11,
      whiteSpace: "pre-wrap",
    },
  }));

  const edges = itemNodes.map((node, index): Edge => ({
    id: `edge-${index}`,
    source: "topic",
    target: node.id,
    animated: index === 0,
  }));

  return { nodes: [topicNode, ...itemNodes], edges };
}

export function MeetingContextBoard({
  query,
  items,
}: {
  query: string | null;
  items: ProjectContextItem[];
}) {
  const graph = toGraph(query, items);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">Live Context</h3>
        <p className="text-sm text-ink-400">
          {query ? `Model searched: ${query}` : "Listening for engineering context..."}
        </p>
      </div>
      {graph.nodes.length > 0 ? (
        <>
          <LiveContextDiagram nodes={graph.nodes} edges={graph.edges} />
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={`${item.source}-${index}`} className="rounded-lg border border-ink-200 bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase text-ink-400">
                    {item.source}
                  </span>
                  {typeof item.score === "number" && (
                    <span className="text-xs text-ink-400">
                      {Math.round(item.score * 100)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 text-sm font-medium text-ink-900">
                  {item.title ?? item.code_path ?? "Context item"}
                </div>
                {item.snippet && (
                  <p className="mt-1 line-clamp-2 text-sm text-ink-500">
                    {item.snippet}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-sm text-ink-400">
          The diagram will appear when the model calls project context.
        </div>
      )}
    </section>
  );
}
