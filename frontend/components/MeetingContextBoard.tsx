"use client";

import { useMemo, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { LiveContextDiagram } from "./LiveContextDiagram";
import type { ProjectContextItem } from "@/lib/realtime";

type ContextGroupId = "frontend" | "backend" | "data" | "decisions";

type ContextGroup = {
  id: ContextGroupId;
  label: string;
  subtitle: string;
  color: string;
  x: number;
  y: number;
};

const GROUPS: ContextGroup[] = [
  {
    id: "frontend",
    label: "Frontend Files",
    subtitle: "UI surfaces, components, client state",
    color: "#dbeafe",
    x: 360,
    y: 0,
  },
  {
    id: "backend",
    label: "Backend APIs",
    subtitle: "FastAPI, realtime, retrieval endpoints",
    color: "#dcfce7",
    x: 360,
    y: 160,
  },
  {
    id: "data",
    label: "Data Layer",
    subtitle: "Supabase tables, embeddings, stored notes",
    color: "#fef3c7",
    x: 360,
    y: 320,
  },
  {
    id: "decisions",
    label: "Decisions / Questions",
    subtitle: "Meeting state and open threads",
    color: "#f3e8ff",
    x: 360,
    y: 480,
  },
];

const GROUP_BY_ID = Object.fromEntries(
  GROUPS.map((group) => [group.id, group]),
) as Record<ContextGroupId, ContextGroup>;

const GROUP_LABELS: Record<ContextGroupId, string> = {
  frontend: "Frontend",
  backend: "Backend",
  data: "Data",
  decisions: "Decision",
};

function toGraph(query: string | null, items: ProjectContextItem[]): {
  nodes: Node[];
  edges: Edge[];
} {
  if (!query || items.length === 0) {
    return { nodes: [], edges: [] };
  }

  const groupedItems = groupContextItems(items);
  const activeGroups = GROUPS.filter((group) => groupedItems[group.id].length > 0);

  const topicNode: Node = {
    id: "topic",
    position: { x: 0, y: 210 },
    data: { label: `Current topic\n${summarizeTopic(query)}` },
    type: "default",
    style: {
      border: "1px solid #111827",
      background: "#111827",
      color: "#ffffff",
      width: 260,
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1.35,
      padding: 12,
      whiteSpace: "pre-wrap",
    },
  };

  const groupNodes = activeGroups.map((group): Node => ({
    id: `group-${group.id}`,
    position: { x: group.x, y: group.y },
    data: { label: `${group.label}\n${group.subtitle}` },
    type: "default",
    style: {
      background: group.color,
      border: "1px solid #94a3b8",
      color: "#0f172a",
      width: 260,
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1.35,
      padding: 10,
      whiteSpace: "pre-wrap",
    },
  }));

  const itemNodes = activeGroups.flatMap((group) =>
    groupedItems[group.id].slice(0, 3).map((item, index): Node => ({
      id: `item-${group.id}-${index}`,
      position: { x: 680, y: group.y + index * 108 - 12 },
      data: { label: itemNodeLabel(item, group.id) },
      type: "default",
      style: {
        background: "#ffffff",
        border: "1px solid #cbd5e1",
        color: "#1f2937",
        width: 310,
        fontSize: 11,
        lineHeight: 1.35,
        padding: 10,
        whiteSpace: "pre-wrap",
      },
    })),
  );

  const groupEdges = activeGroups.map((group): Edge => ({
    id: `topic-to-${group.id}`,
    source: "topic",
    target: `group-${group.id}`,
    animated: group.id === activeGroups[0]?.id,
  }));

  const itemEdges = activeGroups.flatMap((group) =>
    groupedItems[group.id].slice(0, 3).map((_, index): Edge => ({
      id: `${group.id}-to-item-${index}`,
      source: `group-${group.id}`,
      target: `item-${group.id}-${index}`,
      animated: false,
    })),
  );

  return { nodes: [topicNode, ...groupNodes, ...itemNodes], edges: [...groupEdges, ...itemEdges] };
}

export function MeetingContextBoard({
  query,
  items,
}: {
  query: string | null;
  items: ProjectContextItem[];
}) {
  const lastUsefulGraphRef = useRef<{ query: string; items: ProjectContextItem[] } | null>(null);

  if (query && items.length > 0) {
    lastUsefulGraphRef.current = { query, items };
  }

  const visibleQuery = query && items.length > 0 ? query : lastUsefulGraphRef.current?.query ?? null;
  const visibleItems = items.length > 0 ? items : lastUsefulGraphRef.current?.items ?? [];
  const graph = useMemo(
    () => toGraph(visibleQuery, visibleItems),
    [visibleItems, visibleQuery],
  );
  const groupedItems = useMemo(() => groupContextItems(visibleItems), [visibleItems]);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">Live Context</h3>
        <p className="text-sm text-ink-400">
          {visibleQuery
            ? `Shared understanding board for: ${summarizeTopic(visibleQuery)}`
            : "Listening for engineering context..."}
        </p>
      </div>
      {graph.nodes.length > 0 ? (
        <>
          <LiveContextDiagram nodes={graph.nodes} edges={graph.edges} />
          <div className="grid gap-2 md:grid-cols-2">
            {GROUPS.map((group) => {
              const groupItems = groupedItems[group.id];
              if (groupItems.length === 0) return null;

              return (
                <section key={group.id} className="rounded-lg border border-ink-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h4 className="text-xs font-semibold uppercase text-ink-500">
                      {group.label}
                    </h4>
                    <span className="text-xs text-ink-400">{groupItems.length}</span>
                  </div>
                  <ul className="space-y-2">
                    {groupItems.slice(0, 3).map((item, index) => (
                      <li key={`${group.id}-${item.id ?? item.title ?? index}`}>
                        <div className="text-sm font-medium text-ink-900">
                          {displayTitle(item)}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">
                          {whyRelevant(item, group.id)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-sm text-ink-400">
          The diagram will appear when the model calls project context.
        </div>
      )}
    </section>
  );
}

function groupContextItems(items: ProjectContextItem[]) {
  const grouped: Record<ContextGroupId, ProjectContextItem[]> = {
    frontend: [],
    backend: [],
    data: [],
    decisions: [],
  };

  for (const item of items) {
    grouped[classifyContextItem(item)].push(item);
  }

  return grouped;
}

function classifyContextItem(item: ProjectContextItem): ContextGroupId {
  const haystack = [
    item.source,
    item.title,
    item.snippet,
    item.code_path,
    item.code_lines,
    item.url,
    item.ref_url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    haystack.includes("decision") ||
    haystack.includes("blocker") ||
    haystack.includes("question") ||
    haystack.includes("action") ||
    item.source === "meeting" ||
    item.source === "slack" ||
    item.source === "notion"
  ) {
    return "decisions";
  }

  if (
    haystack.includes("supabase") ||
    haystack.includes("meeting_notes") ||
    haystack.includes("meeting_transcript_chunks") ||
    haystack.includes("embedding") ||
    haystack.includes("pgvector") ||
    haystack.includes("database")
  ) {
    return "data";
  }

  if (
    haystack.includes("fastapi") ||
    haystack.includes("backend") ||
    haystack.includes("/context") ||
    haystack.includes("/rt") ||
    haystack.includes("api/") ||
    haystack.includes("router")
  ) {
    return "backend";
  }

  return "frontend";
}

function itemNodeLabel(item: ProjectContextItem, groupId: ContextGroupId) {
  return [
    `${GROUP_LABELS[groupId]} · ${item.source}${scoreLabel(item.score)}`,
    displayTitle(item),
    whyRelevant(item, groupId),
  ].join("\n");
}

function displayTitle(item: ProjectContextItem) {
  return item.code_path ?? item.title ?? item.snippet ?? "Context item";
}

function whyRelevant(item: ProjectContextItem, groupId: ContextGroupId) {
  const snippet = item.snippet?.trim();
  if (snippet) return snippet;

  if (item.code_lines) return `Relevant logic: ${item.code_lines}`;
  if (item.code_path) return `Owns part of the ${GROUP_BY_ID[groupId].label.toLowerCase()} flow.`;
  if (item.ref_url ?? item.url) return "Linked project context for the current discussion.";

  return `Related ${GROUP_BY_ID[groupId].label.toLowerCase()} context for the current topic.`;
}

function summarizeTopic(query: string) {
  return query.length > 90 ? `${query.slice(0, 87)}...` : query;
}

function scoreLabel(score: number | undefined) {
  return typeof score === "number" ? ` · ${Math.round(score * 100)}%` : "";
}
