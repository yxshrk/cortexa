"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useRef } from "react";
import { toExcalidrawSkeleton, type WhiteboardElement } from "@/lib/whiteboardElements";

type LiveContextWhiteboardProps = {
  elements: WhiteboardElement[];
};

export default function LiveContextWhiteboardInner({ elements }: LiveContextWhiteboardProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const sceneElements = useMemo(() => {
    if (elements.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return convertToExcalidrawElements(toExcalidrawSkeleton(elements) as any);
  }, [elements]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({ elements: sceneElements });
    if (sceneElements.length > 0) {
      api.scrollToContent(sceneElements, { fitToViewport: true, animate: false });
    }
  }, [sceneElements]);

  return (
    <div className="h-[48rem] w-full max-w-full overflow-hidden rounded-lg border border-ink-200 bg-white">
      <Excalidraw
        initialData={{
          elements: sceneElements,
          appState: {
            viewBackgroundColor: "#ffffff",
            zenModeEnabled: true,
            gridModeEnabled: false,
          },
          scrollToContent: true,
        }}
        viewModeEnabled
        zenModeEnabled
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            saveAsImage: false,
          },
        }}
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
      />
    </div>
  );
}
