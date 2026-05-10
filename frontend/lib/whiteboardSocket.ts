// Client for the backend `/ws/whiteboard/{meeting_id}` channel. The frontend
// forwards transcript completions; the backend runs retrieval + the diagram
// planner and pushes back `whiteboard.update` events.

import type { ProjectContextItem } from "@/lib/realtime";
import type { WhiteboardPlan } from "@/lib/whiteboardElements";

export type PlannerStatusState = "idle" | "planning" | "ready" | "error";

export type WhiteboardServerEvent =
  | {
      type: "whiteboard.update";
      plan: WhiteboardPlan;
      context?: ProjectContextItem[];
      transcriptWindow?: string;
    }
  | {
      type: "planner.status";
      state: PlannerStatusState;
      message?: string;
    }
  | { type: "whiteboard.reset" }
  | { type: "error"; message: string };

export type WhiteboardClientMessage =
  | { type: "transcript.completed"; text: string }
  | { type: "session.reset" }
  | { type: "ping" };

export type WhiteboardSocket = {
  send: (msg: WhiteboardClientMessage) => void;
  close: () => void;
};

export type ConnectWhiteboardOptions = {
  fastApiUrl: string;
  meetingId: string;
  projectId: string;
  onEvent: (event: WhiteboardServerEvent) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
};

export async function connectWhiteboardSocket(
  opts: ConnectWhiteboardOptions,
): Promise<WhiteboardSocket> {
  const url = `${httpToWs(opts.fastApiUrl)}/ws/whiteboard/${encodeURIComponent(
    opts.meetingId,
  )}?projectId=${encodeURIComponent(opts.projectId)}`;

  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      reject(new Error(`Whiteboard WS failed to connect at ${url}`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data as string) as Record<string, unknown>;
      const type = payload.type as string | undefined;
      if (type === "whiteboard.update") {
        opts.onEvent({
          type,
          plan: payload.plan as WhiteboardPlan,
          context: payload.context as ProjectContextItem[] | undefined,
          transcriptWindow: payload.transcript_window as string | undefined,
        });
      } else if (type === "planner.status") {
        opts.onEvent({
          type,
          state: (payload.state as PlannerStatusState) ?? "idle",
          message: payload.message as string | undefined,
        });
      } else if (type === "whiteboard.reset") {
        opts.onEvent({ type });
      } else if (type === "error") {
        opts.onEvent({ type, message: (payload.message as string) ?? "" });
      } else if (type === "pong") {
        // ignore
      }
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  ws.addEventListener("error", () => {
    opts.onError(new Error("Whiteboard WS error"));
  });

  ws.addEventListener("close", () => {
    opts.onClose?.();
  });

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => ws.close(),
  };
}

function httpToWs(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url.replace(/^\/\//, "ws://");
}
