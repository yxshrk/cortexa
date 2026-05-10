import type { DiagramGroup, DiagramPlan } from "@/lib/diagramPlan";
import type { WhiteboardElement } from "@/lib/whiteboardElements";

const COLUMN_X: Record<Exclude<DiagramGroup, "topic">, number> = {
  frontend: 460,
  backend: 800,
  data: 1140,
  decision: 1480,
};

const COLUMN_LABEL: Record<DiagramGroup, string> = {
  topic: "Current topic",
  frontend: "Frontend",
  backend: "Backend",
  data: "Data",
  decision: "Decisions / Open questions",
};

const COLUMN_FILL: Record<DiagramGroup, string> = {
  topic: "#1d4ed8",
  frontend: "#dbeafe",
  backend: "#dcfce7",
  data: "#fef3c7",
  decision: "#f3e8ff",
};

const COLUMN_STROKE: Record<DiagramGroup, string> = {
  topic: "#1e3a8a",
  frontend: "#1d4ed8",
  backend: "#15803d",
  data: "#a16207",
  decision: "#7e22ce",
};

const NODE_WIDTH = 280;
const NODE_HEIGHT = 96;
const NODE_GAP_Y = 28;
const TOPIC_WIDTH = 320;
const TOPIC_HEIGHT = 140;
const HEADER_OFFSET = 36;

export function diagramPlanToElements(plan: DiagramPlan): WhiteboardElement[] {
  const elements: WhiteboardElement[] = [];
  const grouped: Record<DiagramGroup, DiagramPlan["nodes"]> = {
    topic: [],
    frontend: [],
    backend: [],
    data: [],
    decision: [],
  };

  for (const node of plan.nodes ?? []) {
    grouped[node.group]?.push(node);
  }

  // Topic anchor on the left
  const topicNode = grouped.topic[0];
  if (topicNode) {
    elements.push({
      kind: "rect",
      id: topicNode.id || "topic",
      x: 60,
      y: 280,
      width: TOPIC_WIDTH,
      height: TOPIC_HEIGHT,
      label: shortenLabel(topicNode.label || plan.topic, 110),
      backgroundColor: COLUMN_FILL.topic,
      strokeColor: COLUMN_STROKE.topic,
      fontSize: 20,
      bold: true,
    });
  }

  // One column per category, header text on top, nodes stacked below
  const columns: Array<Exclude<DiagramGroup, "topic">> = [
    "frontend",
    "backend",
    "data",
    "decision",
  ];

  for (const group of columns) {
    const nodes = grouped[group];
    if (nodes.length === 0) continue;

    const columnX = COLUMN_X[group];

    elements.push({
      kind: "text",
      id: `header_${group}`,
      x: columnX,
      y: 40,
      text: COLUMN_LABEL[group].toUpperCase(),
      fontSize: 14,
      strokeColor: COLUMN_STROKE[group],
    });

    nodes.forEach((node, index) => {
      const y = 40 + HEADER_OFFSET + index * (NODE_HEIGHT + NODE_GAP_Y);
      elements.push({
        kind: "rect",
        id: node.id,
        x: columnX,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        label: composeNodeLabel(node.label, node.detail),
        backgroundColor: COLUMN_FILL[group],
        strokeColor: COLUMN_STROKE[group],
        fontSize: 16,
      });
    });
  }

  // Translate edges, but only when both endpoints map to placed shapes
  const placedIds = new Set(elements.filter((e) => e.kind !== "arrow" && e.kind !== "text").map((e) => e.id));
  for (const [index, edge] of (plan.edges ?? []).entries()) {
    if (!placedIds.has(edge.from) || !placedIds.has(edge.to)) continue;
    elements.push({
      kind: "arrow",
      id: `edge_${index}_${edge.from}_${edge.to}`,
      from: edge.from,
      to: edge.to,
      label: edge.label && edge.label.length > 0 ? shortenLabel(edge.label, 24) : undefined,
    });
  }

  return elements;
}

function composeNodeLabel(label: string, detail?: string) {
  const cleanLabel = (label || "").trim();
  const cleanDetail = (detail || "").trim();
  if (!cleanDetail) return shortenLabel(cleanLabel, 80);
  return `${shortenLabel(cleanLabel, 60)}\n\n${shortenLabel(cleanDetail, 140)}`;
}

function shortenLabel(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
