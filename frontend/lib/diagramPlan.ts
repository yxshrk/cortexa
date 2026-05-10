import type { ProjectContextItem } from "@/lib/realtime";

export type DiagramGroup = "topic" | "frontend" | "backend" | "data" | "decision";

export type DiagramPlanNode = {
  id: string;
  label: string;
  detail?: string;
  group: DiagramGroup;
};

export type DiagramPlanEdge = {
  from: string;
  to: string;
  label?: string;
};

export type DiagramPlan = {
  topic: string;
  nodes: DiagramPlanNode[];
  edges: DiagramPlanEdge[];
};

export const DiagramPlanJsonSchema = {
  name: "diagram_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      topic: {
        type: "string",
        description: "Clean one-line summary of what the team is discussing.",
      },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              description: "Stable short id using lowercase letters, numbers, hyphens, or underscores.",
            },
            label: {
              type: "string",
              description: "Short participant-facing node label.",
            },
            detail: {
              type: "string",
              description: "Why this node matters to the current engineering discussion.",
            },
            group: {
              type: "string",
              enum: ["topic", "frontend", "backend", "data", "decision"],
            },
          },
          required: ["id", "label", "detail", "group"],
        },
      },
      edges: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            label: { type: "string" },
          },
          required: ["from", "to", "label"],
        },
      },
    },
    required: ["topic", "nodes", "edges"],
  },
  strict: true,
} as const;

export function fallbackDiagramPlan(topic: string, items: ProjectContextItem[]): DiagramPlan {
  const nodes: DiagramPlanNode[] = [
    {
      id: "topic",
      label: cleanTopic(topic),
      detail: "Current engineering discussion topic.",
      group: "topic",
    },
    ...items.slice(0, 8).map((item, index) => ({
      id: `context_${index}`,
      label: item.code_path ?? item.title ?? item.source,
      detail:
        item.snippet ??
        item.code_lines ??
        "Retrieved project context related to the current discussion.",
      group: classifyFallbackGroup(item),
    })),
  ];

  return {
    topic: cleanTopic(topic),
    nodes,
    edges: nodes
      .filter((node) => node.id !== "topic")
      .map((node) => ({ from: "topic", to: node.id, label: "related context" })),
  };
}

function classifyFallbackGroup(item: ProjectContextItem): DiagramGroup {
  const text = [item.source, item.title, item.snippet, item.code_path, item.code_lines]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (text.includes("supabase") || text.includes("database") || text.includes("embedding")) {
    return "data";
  }
  if (text.includes("api") || text.includes("backend") || text.includes("fastapi")) {
    return "backend";
  }
  if (
    text.includes("decision") ||
    text.includes("question") ||
    text.includes("blocker") ||
    item.source === "slack" ||
    item.source === "notion" ||
    item.source === "meeting"
  ) {
    return "decision";
  }

  return "frontend";
}

function cleanTopic(topic: string) {
  return topic.length > 110 ? `${topic.slice(0, 107)}...` : topic;
}
