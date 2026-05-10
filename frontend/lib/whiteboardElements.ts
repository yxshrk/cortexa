// Internal whiteboard element abstraction. The backend planner emits these
// directly; the Excalidraw renderer converts them via toExcalidrawSkeleton ->
// convertToExcalidrawElements.

export type WBShapeKind = "rect" | "ellipse" | "diamond";

export type WBShape = {
  kind: WBShapeKind;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  backgroundColor?: string;
  strokeColor?: string;
  fontSize?: number;
  bold?: boolean;
};

export type WBArrow = {
  kind: "arrow";
  id: string;
  from: string;
  to: string;
  label?: string;
  strokeColor?: string;
};

export type WBText = {
  kind: "text";
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  strokeColor?: string;
};

export type WhiteboardElement = WBShape | WBArrow | WBText;

export type WhiteboardLayout =
  | "flow"
  | "comparison"
  | "hierarchy"
  | "timeline"
  | "kanban"
  | "cluster"
  | "matrix"
  | "freeform";

export type WhiteboardPlan = {
  topic: string;
  layout: WhiteboardLayout;
  rationale?: string;
  elements: WhiteboardElement[];
};

type ExcalidrawSkeleton = Record<string, unknown>;

export function toExcalidrawSkeleton(elements: WhiteboardElement[]): ExcalidrawSkeleton[] {
  const shapeIndex = new Map<string, WBShape>();
  for (const element of elements) {
    if (element.kind !== "arrow" && element.kind !== "text") {
      shapeIndex.set(element.id, element);
    }
  }

  const skeleton: ExcalidrawSkeleton[] = [];

  for (const element of elements) {
    if (element.kind === "text") {
      skeleton.push({
        type: "text",
        id: element.id,
        x: element.x,
        y: element.y,
        text: element.text,
        fontSize: element.fontSize ?? 18,
        strokeColor: element.strokeColor ?? "#1f2937",
      });
      continue;
    }

    if (element.kind === "rect" || element.kind === "ellipse" || element.kind === "diamond") {
      skeleton.push({
        type: element.kind === "rect" ? "rectangle" : element.kind,
        id: element.id,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        backgroundColor: element.backgroundColor ?? "#f8f9fa",
        strokeColor: element.strokeColor ?? "#1f2937",
        fillStyle: "solid",
        strokeWidth: 1.25,
        roughness: 1,
        roundness: element.kind === "rect" ? { type: 3 } : undefined,
        ...(element.label
          ? {
              label: {
                text: element.label,
                fontSize: element.fontSize ?? 18,
                strokeColor: element.strokeColor ?? "#1f2937",
                ...(element.bold ? { fontFamily: 3 } : {}),
              },
            }
          : {}),
      });
      continue;
    }

    if (element.kind === "arrow") {
      const source = shapeIndex.get(element.from);
      const target = shapeIndex.get(element.to);
      if (!source || !target) continue;

      // Clip the source→target line to each shape's bounding box so the
      // arrow's visible segment starts at the source border (not its center)
      // and ends at the target border. Without this, Excalidraw renders
      // center-to-center and both halves disappear into the shapes.
      const sourceCenterX = source.x + source.width / 2;
      const sourceCenterY = source.y + source.height / 2;
      const targetCenterX = target.x + target.width / 2;
      const targetCenterY = target.y + target.height / 2;

      const start = rectExitPoint(
        sourceCenterX,
        sourceCenterY,
        source.width,
        source.height,
        targetCenterX,
        targetCenterY,
        4,
      );
      const end = rectExitPoint(
        targetCenterX,
        targetCenterY,
        target.width,
        target.height,
        sourceCenterX,
        sourceCenterY,
        4,
      );

      skeleton.push({
        type: "arrow",
        id: element.id,
        x: start.x,
        y: start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y],
        ],
        strokeColor: element.strokeColor ?? "#475569",
        strokeWidth: 1.25,
        roughness: 1,
        start: { id: element.from },
        end: { id: element.to },
        ...(element.label
          ? {
              label: {
                text: element.label,
                fontSize: 14,
                strokeColor: element.strokeColor ?? "#475569",
              },
            }
          : {}),
      });
      continue;
    }
  }

  return skeleton;
}

// Where does a ray from (cx, cy) toward (towardX, towardY) exit a rectangle
// of (width, height) centered at (cx, cy)? Treats ellipses/diamonds as their
// bounding box — close enough for arrow attachment at hackathon quality.
// `margin` adds a small gap so arrow heads don't touch the shape border.
function rectExitPoint(
  cx: number,
  cy: number,
  width: number,
  height: number,
  towardX: number,
  towardY: number,
  margin: number,
): { x: number; y: number } {
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfW = width / 2 + margin;
  const halfH = height / 2 + margin;

  const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy);
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}
