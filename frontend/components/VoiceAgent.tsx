"use client";

import { useState } from "react";
import { BriefingPanel, type Briefing } from "./BriefingPanel";
import { MeetingContextBoard } from "./MeetingContextBoard";
import { captureMeetingAudio, MeetingAudioError } from "@/lib/meetingAudio";
import { connectRealtime, type ProjectContextItem, type RealtimeConnection } from "@/lib/realtime";
import { supabase } from "@/lib/supabase";
import type { VoiceNote } from "@/lib/voiceNoteSchema";

type VoiceAgentStatus = "idle" | "loading" | "ready" | "listening" | "error";

export function VoiceAgent({
  projectId,
  meetingId,
}: {
  projectId: string;
  meetingId: string;
}) {
  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [contextQuery, setContextQuery] = useState<string | null>(null);
  const [contextItems, setContextItems] = useState<ProjectContextItem[]>([]);
  const [manualQuery, setManualQuery] = useState("Safari login redirect");
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  const [transcriptPreview, setTranscriptPreview] = useState("");
  const [lastNoteCount, setLastNoteCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function loadBriefing() {
    setStatus("loading");
    setError(null);
    const fastApiUrl = process.env.NEXT_PUBLIC_FASTAPI_URL;
    if (!fastApiUrl) {
      setStatus("error");
      setError("NEXT_PUBLIC_FASTAPI_URL is not configured.");
      return;
    }

    try {
      const res = await fetch(`${fastApiUrl}/context/briefing?projectId=${projectId}`);
      if (!res.ok) throw new Error(`Briefing failed: ${res.status}`);
      setBriefing((await res.json()) as Briefing);
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
    const fastApiUrl = process.env.NEXT_PUBLIC_FASTAPI_URL;
    if (!fastApiUrl) {
      setStatus("error");
      setError("NEXT_PUBLIC_FASTAPI_URL is not configured.");
      return;
    }

    try {
      const activeBriefing = briefing ?? (await fetchBriefing(fastApiUrl));
      setBriefing(activeBriefing);

      const tokenResponse = await fetch(`${fastApiUrl}/rt/token`, {
        method: "POST",
      });
      if (!tokenResponse.ok) {
        throw new Error(`Token request failed: ${tokenResponse.status}`);
      }
      const token = (await tokenResponse.json()) as { value?: string };
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
        projectId,
        fastApiUrl,
        onTranscript: (event) => {
          if (event.type === "delta") {
            setTranscriptPreview((prev) => `${prev}${event.text}`.slice(-500));
          } else {
            setTranscriptPreview(event.text);
            void persistTranscriptChunk(event.text, activeBriefing);
          }
        },
        onContextItems: (query, items) => {
          setContextQuery(query);
          setContextItems(items);
        },
        onError: (err) => {
          setError(err.message);
        },
      });

      setConnection(realtime);
      setStatus("listening");
    } catch (err) {
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
    setStatus(briefing ? "ready" : "idle");
  }

  async function runManualContextQuery() {
    const query = manualQuery.trim();
    const fastApiUrl = process.env.NEXT_PUBLIC_FASTAPI_URL;
    if (!query || !fastApiUrl) return;

    try {
      const res = await fetch(`${fastApiUrl}/context/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, query, k: 6 }),
      });
      if (!res.ok) throw new Error(`Context query failed: ${res.status}`);
      const items = (await res.json()) as ProjectContextItem[];
      setContextQuery(query);
      setContextItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to query context.");
    }
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

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefingPanel briefing={briefing} />
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={manualQuery}
              onChange={(event) => setManualQuery(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-ink-500"
              placeholder="Demo context query"
            />
            <button
              onClick={runManualContextQuery}
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:border-ink-400"
            >
              Query
            </button>
          </div>
          <MeetingContextBoard query={contextQuery} items={contextItems} />
        </div>
      </div>

      {transcriptPreview && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
          Hidden transcript signal: {transcriptPreview}
          <span className="ml-2 text-ink-400">Notes inserted: {lastNoteCount}</span>
        </div>
      )}
    </section>
  );
}

function buildBriefingPrompt(briefing: Briefing) {
  return [
    "You are listening to an engineering meeting for Project Brain.",
    "Call search_project_context when project context would help participants understand the discussion.",
    `Project summary: ${briefing.project_summary ?? "Unknown project"}`,
    `Themes: ${(briefing.themes ?? []).join(", ")}`,
    `Active files: ${(briefing.active_files ?? []).map((file) => file.path).filter(Boolean).join(", ")}`,
    "Prefer concise search queries of 3-8 words.",
  ].join("\n");
}
