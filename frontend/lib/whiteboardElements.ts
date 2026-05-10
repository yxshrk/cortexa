// Internal whiteboard element abstraction. The planner emits these (or for
// now, we translate from DiagramPlan), and the Excalidraw renderer converts
// them via toExcalidrawSkeleton -> convertToExcalidrawElements.
//
// Keeping this provider-agnostic means we can later swap the planner's output
// shape (e.g. line-numbered diff ops as in autopreso) without touching the
// renderer.

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

      skeleton.push({
        type: "arrow",
        id: element.id,
        x: source.x + source.width / 2,
        y: source.y + source.height / 2,
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
