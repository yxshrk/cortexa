"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LiveContextWhiteboard } from "./LiveContextWhiteboard";
import { fallbackDiagramPlan, type DiagramGroup, type DiagramPlan } from "@/lib/diagramPlan";
import { diagramPlanToElements } from "@/lib/diagramPlanToElements";
import type { ProjectContextItem } from "@/lib/realtime";

const GROUP_LABEL: Record<DiagramGroup, string> = {
  topic: "Current Topic",
  frontend: "Frontend",
  backend: "Backend",
  data: "Data",
  decision: "Decision",
};

const SIDE_GROUPS: DiagramGroup[] = ["frontend", "backend", "data", "decision"];

export function MeetingContextBoard({
  query,
  items,
}: {
  query: string | null;
  items: ProjectContextItem[];
}) {
  const [plannedDiagram, setPlannedDiagram] = useState<DiagramPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const lastUsefulPlanRef = useRef<DiagramPlan | null>(null);
  const visibleTopic = query?.trim() || lastUsefulPlanRef.current?.topic || null;

  useEffect(() => {
    if (!query || items.length === 0) return;

    const activeQuery = query;
    const controller = new AbortController();
    setPlanning(true);
    setPlannerError(null);

    async function planDiagram() {
      try {
        const response = await fetch("/api/diagram/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: query, contextItems: items }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Diagram planning failed: ${response.status}`);
        }

        const plan = (await response.json()) as DiagramPlan;
        const normalized = normalizePlan(plan, activeQuery, items);
        lastUsefulPlanRef.current = normalized;
        setPlannedDiagram(normalized);
      } catch (error) {
        if (controller.signal.aborted) return;
        const fallback = fallbackDiagramPlan(activeQuery, items);
        lastUsefulPlanRef.current = fallback;
        setPlannedDiagram(fallback);
        setPlannerError(error instanceof Error ? error.message : "Diagram planner failed.");
      } finally {
        if (!controller.signal.aborted) setPlanning(false);
      }
    }

    void planDiagram();

    return () => controller.abort();
  }, [items, query]);

  const visiblePlan = plannedDiagram ?? lastUsefulPlanRef.current;
  const whiteboardElements = useMemo(
    () => (visiblePlan ? diagramPlanToElements(visiblePlan) : []),
    [visiblePlan],
  );
  const groupedNodes = useMemo(() => groupPlanNodes(visiblePlan), [visiblePlan]);
  const hasContent = whiteboardElements.length > 0;

  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink-900">Live Context</h3>
          {planning && <span className="text-xs text-ink-400">Planning diagram...</span>}
        </div>
        <p className="text-sm text-ink-400">
          {visibleTopic
            ? `Shared understanding board for: ${summarizeTopic(visibleTopic)}`
            : "Listening for engineering context..."}
        </p>
      </div>

      {plannerError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
          Using deterministic diagram fallback. {plannerError}
        </div>
      )}

      {hasContent ? (
        <>
          <LiveContextWhiteboard elements={whiteboardElements} />
          <div className="grid gap-2 md:grid-cols-2">
            {SIDE_GROUPS.map((group) => {
              const nodes = groupedNodes[group];
              if (nodes.length === 0) return null;

              return (
                <section key={group} className="rounded-lg border border-ink-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h4 className="text-xs font-semibold uppercase text-ink-500">
                      {GROUP_LABEL[group]}
                    </h4>
                    <span className="text-xs text-ink-400">{nodes.length}</span>
                  </div>
                  <ul className="space-y-2">
                    {nodes.slice(0, 4).map((node) => (
                      <li key={node.id}>
                        <div className="text-sm font-medium text-ink-900">{node.label}</div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">{node.detail}</p>
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
          The whiteboard will appear when the model calls project context.
        </div>
      )}
    </section>
  );
}

function groupPlanNodes(plan: DiagramPlan | null) {
  const grouped: Record<DiagramGroup, DiagramPlan["nodes"]> = {
    topic: [],
    frontend: [],
    backend: [],
    data: [],
    decision: [],
  };

  for (const node of plan?.nodes ?? []) {
    grouped[node.group]?.push(node);
  }

  return grouped;
}

function normalizePlan(plan: DiagramPlan, topic: string, items: ProjectContextItem[]) {
  const fallback = fallbackDiagramPlan(topic, items);
  const nodes = plan.nodes?.length ? plan.nodes : fallback.nodes;
  const hasTopic = nodes.some((node) => node.id === "topic" && node.group === "topic");
  const normalizedNodes = hasTopic
    ? nodes
    : [
        {
          id: "topic",
          label: plan.topic || topic,
          detail: "Current discussion topic.",
          group: "topic" as const,
        },
        ...nodes,
      ];

  return {
    topic: plan.topic || topic,
    nodes: normalizedNodes.map((node, index) => ({
      ...node,
      id: node.id || `node_${index}`,
      label: node.label || "Context",
      detail: node.detail || "Relevant context for the current engineering discussion.",
      group: node.group || "frontend",
    })),
    edges: plan.edges?.length ? plan.edges : fallback.edges,
  } satisfies DiagramPlan;
}

function summarizeTopic(query: string) {
  return query.length > 90 ? `${query.slice(0, 87)}...` : query;
}
