"use client";

import { useEffect, useRef, useState } from "react";
import { activeFileLabel, BriefingPanel, themeLabel, type Briefing } from "./BriefingPanel";
import { MeetingContextBoard } from "./MeetingContextBoard";
import { captureMeetingAudio, MeetingAudioError } from "@/lib/meetingAudio";
import { connectRealtime, type ProjectContextItem, type RealtimeConnection } from "@/lib/realtime";
import { supabase } from "@/lib/supabase";
import type { VoiceNote } from "@/lib/voiceNoteSchema";
import type { WhiteboardPlan } from "@/lib/whiteboardElements";
import {
  connectWhiteboardSocket,
  type PlannerStatusState,
  type WhiteboardSocket,
} from "@/lib/whiteboardSocket";

type VoiceAgentStatus = "idle" | "loading" | "ready" | "listening" | "error";

const DEFAULT_FASTAPI_URL = "http://localhost:8000";

export function VoiceAgent({
  projectId,
  meetingId,
}: {
  projectId: string;
  meetingId: string;
}) {
  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [manualQuery, setManualQuery] = useState("Safari login redirect");
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  const [lastNoteCount, setLastNoteCount] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [transcriptChunks, setTranscriptChunks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [plan, setPlan] = useState<WhiteboardPlan | null>(null);
  const [contextItems, setContextItems] = useState<ProjectContextItem[]>([]);
  const [plannerStatus, setPlannerStatus] = useState<PlannerStatusState>("idle");
  const [plannerMessage, setPlannerMessage] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const whiteboardSocketRef = useRef<WhiteboardSocket | null>(null);

  useEffect(() => {
    return () => {
      whiteboardSocketRef.current?.close();
      whiteboardSocketRef.current = null;
    };
  }, []);

  async function loadBriefing() {
    setStatus("loading");
    setError(null);
    const fastApiUrl = getFastApiUrl();

    try {
      setBriefing(await fetchBriefing(fastApiUrl));
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to load briefing.");
    }
  }

  async function startMicListener() {
    await startListener("mic");
  }

  async function startMeetListener() {
    await startListener("meet");
  }

  async function startListener(mode: "meet" | "mic") {
    setError(null);
    setPartialTranscript("");
    setStatus("loading");
    const fastApiUrl = getFastApiUrl();

    try {
      const activeBriefing = briefing ?? (await fetchBriefing(fastApiUrl));
      setBriefing(activeBriefing);

      const wb = await connectWhiteboardSocket({
        fastApiUrl,
        meetingId,
        projectId,
        onEvent: (event) => {
          if (event.type === "whiteboard.update") {
            setPlan(event.plan);
            setContextItems(event.context ?? []);
            if (event.plan.topic) setTopic(event.plan.topic);
            setPlannerStatus("ready");
            setPlannerMessage(null);
          } else if (event.type === "planner.status") {
            setPlannerStatus(event.state);
            setPlannerMessage(event.message ?? null);
          } else if (event.type === "whiteboard.reset") {
            setPlan(null);
            setContextItems([]);
            setTopic(null);
          } else if (event.type === "error") {
            setPlannerStatus("error");
            setPlannerMessage(event.message);
          }
        },
        onError: (err) => {
          setError(err.message);
        },
      });
      whiteboardSocketRef.current = wb;

      const token = await getRealtimeToken(fastApiUrl);
      if (!token.value) throw new Error("Token response missing value.");

      const stream =
        mode === "meet"
          ? await captureMeetingAudio().catch(async (err) => {
              if (
                err instanceof MeetingAudioError &&
                err.message === "TAB_AUDIO_MISSING"
              ) {
                setError(
                  "Tab audio was not shared. Re-pick the Google Meet tab and check Share tab audio. Falling back to mic-only for now.",
                );
                return navigator.mediaDevices.getUserMedia({ audio: true });
              }
              throw err;
            })
          : await navigator.mediaDevices.getUserMedia({ audio: true });

      const realtime = await connectRealtime({
        stream,
        token: token.value,
        briefingPrompt: buildBriefingPrompt(activeBriefing),
        onTranscript: (event) => {
          if (event.type === "delta") {
            setPartialTranscript((current) => `${current}${event.text}`.slice(-900));
          } else {
            setPartialTranscript("");
            const finalText = event.text.trim();
            if (!finalText) return;
            setTranscriptChunks((chunks) => [finalText, ...chunks].slice(0, 8));
            whiteboardSocketRef.current?.send({
              type: "transcript.completed",
              text: finalText,
            });
            void persistTranscriptChunk(finalText, activeBriefing);
          }
        },
        onError: (err) => {
          setError(err.message);
        },
      });

      setConnection(realtime);
      setStatus("listening");
    } catch (err) {
      whiteboardSocketRef.current?.close();
      whiteboardSocketRef.current = null;
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to start listener.");
    }
  }

  async function fetchBriefing(fastApiUrl: string) {
    setStatus("loading");
    const res = await fetch(`${fastApiUrl}/context/briefing?projectId=${projectId}`);
    if (!res.ok) throw new Error(`Briefing failed: ${res.status}`);
    const data = (await res.json()) as Briefing;
    setStatus("ready");
    return data;
  }

  function stopListener() {
    connection?.close();
    setConnection(null);
    whiteboardSocketRef.current?.close();
    whiteboardSocketRef.current = null;
    setStatus(briefing ? "ready" : "idle");
  }

  function sendManualQuery() {
    const text = manualQuery.trim();
    if (!text) return;
    setTopic(text);

    const wb = whiteboardSocketRef.current;
    if (wb) {
      wb.send({ type: "transcript.completed", text });
      return;
    }

    // Listener isn't running — open a one-shot connection so the user can
    // still drive the whiteboard from the manual input.
    void (async () => {
      try {
        const fastApiUrl = getFastApiUrl();
        const oneShot = await connectWhiteboardSocket({
          fastApiUrl,
          meetingId,
          projectId,
          onEvent: (event) => {
            if (event.type === "whiteboard.update") {
              setPlan(event.plan);
              setContextItems(event.context ?? []);
              if (event.plan.topic) setTopic(event.plan.topic);
              setPlannerStatus("ready");
              setPlannerMessage(null);
            } else if (event.type === "planner.status") {
              setPlannerStatus(event.state);
              setPlannerMessage(event.message ?? null);
            } else if (event.type === "error") {
              setPlannerStatus("error");
              setPlannerMessage(event.message);
            }
          },
          onError: (err) => setError(err.message),
        });
        whiteboardSocketRef.current = oneShot;
        oneShot.send({ type: "transcript.completed", text });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open whiteboard socket.");
      }
    })();
  }

  async function persistTranscriptChunk(text: string, activeBriefing: Briefing) {
    const transcript = text.trim();
    if (!transcript) return;

    try {
      await supabase.from("meeting_transcript_chunks").insert({
        meeting_id: meetingId,
        speaker: null,
        start_ms: null,
        end_ms: null,
        text: transcript,
      });

      const res = await fetch("/api/voice/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript_chunk: transcript,
          briefing: activeBriefing,
        }),
      });

      if (!res.ok) {
        throw new Error(`Summarize failed: ${res.status}`);
      }

      const payload = (await res.json()) as { notes?: VoiceNote[] };
      const notes = payload.notes ?? [];

      for (const note of notes) {
        const { error: insertError } = await supabase.from("meeting_notes").insert({
          project_id: projectId,
          meeting_id: meetingId,
          type: note.type,
          text: note.text,
          refs_to: note.refs_to,
          embedding: note.embedding,
        });

        if (insertError) {
          throw new Error(insertError.message);
        }
      }

      setLastNoteCount((count) => count + notes.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to persist transcript.");
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-900">Google Meet Listener</h2>
          <p className="text-sm text-ink-400">
            Project {projectId.slice(0, 8)} · Meeting {meetingId.slice(0, 8)}
          </p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-400">
            Status: {status}
            {plannerStatus !== "idle" && plannerStatus !== "ready" && (
              <span className="ml-2 normal-case text-ink-500">
                · planner: {plannerStatus}
                {plannerMessage ? ` (${plannerMessage})` : ""}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status !== "listening" && (
            <button
              onClick={startMicListener}
              className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:border-ink-400"
            >
              Mic only
            </button>
          )}
          <button
            onClick={status === "listening" ? stopListener : startMeetListener}
            className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700"
          >
            {status === "listening" ? "Stop" : "Start Meet listener"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        <BriefingPanel briefing={briefing} />
        <div className="min-w-0 space-y-3">
          <div className="flex gap-2">
            <input
              value={manualQuery}
              onChange={(event) => setManualQuery(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-ink-500"
              placeholder="Send a topic to the whiteboard"
            />
            <button
              onClick={sendManualQuery}
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:border-ink-400"
            >
              Send
            </button>
          </div>
          <MeetingContextBoard
            plan={plan}
            topic={topic}
            planning={plannerStatus === "planning"}
            plannerMessage={plannerStatus === "error" ? plannerMessage : null}
            contextItems={contextItems}
          />
        </div>
      </div>

      {!briefing && status !== "loading" && status !== "listening" && (
        <button
          onClick={loadBriefing}
          className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:border-ink-400"
        >
          Load Briefing
        </button>
      )}

      {lastNoteCount > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
          Notes inserted: {lastNoteCount}
        </div>
      )}

      <section className="rounded-lg border border-ink-200 bg-ink-50 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink-900">Realtime Transcript</h3>
          <span className="text-xs text-ink-400">
            {transcriptChunks.length > 0 ? `${transcriptChunks.length} chunks` : "Waiting for speech"}
          </span>
        </div>

        {partialTranscript || transcriptChunks.length > 0 ? (
          <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
            {partialTranscript && (
              <p className="rounded-lg border border-ink-200 bg-white p-3 text-sm text-ink-600">
                {partialTranscript}
              </p>
            )}
            {transcriptChunks.map((chunk, index) => (
              <p
                key={`${chunk.slice(0, 24)}-${index}`}
                className="rounded-lg bg-white p-3 text-sm text-ink-600"
              >
                {chunk}
              </p>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-ink-200 bg-white p-5 text-center text-sm text-ink-400">
            Start the listener and speak to see live transcript chunks here.
          </div>
        )}
      </section>

    </section>
  );
}

function buildBriefingPrompt(briefing: Briefing) {
  return [
    "You are listening to an engineering meeting for Project Brain.",
    "Transcribe what is said as accurately as possible. Do not interject or respond.",
    `Project summary: ${briefing.project_summary ?? "Unknown project"}`,
    `Themes: ${(briefing.themes ?? []).map(themeLabel).join(", ")}`,
    `Active files: ${(briefing.active_files ?? []).map(activeFileLabel).filter(Boolean).join(", ")}`,
  ].join("\n");
}

async function getRealtimeToken(fastApiUrl: string) {
  const response = await fetch(`${fastApiUrl}/rt/token`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  return (await response.json()) as { value?: string };
}

function getFastApiUrl() {
  return process.env.NEXT_PUBLIC_FASTAPI_URL ?? DEFAULT_FASTAPI_URL;
}
