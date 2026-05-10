"use client";

import dynamic from "next/dynamic";
import type { WhiteboardElement } from "@/lib/whiteboardElements";

const LiveContextWhiteboardInner = dynamic(() => import("./LiveContextWhiteboardInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[34rem] items-center justify-center rounded-lg border border-ink-200 bg-white text-sm text-ink-400">
      Loading whiteboard…
    </div>
  ),
});

export function LiveContextWhiteboard({ elements }: { elements: WhiteboardElement[] }) {
  return <LiveContextWhiteboardInner elements={elements} />;
}
