"use client";

import { useState } from "react";
import { activeFileLabel, BriefingPanel, themeLabel, type Briefing } from "./BriefingPanel";
import { MeetingContextBoard } from "./MeetingContextBoard";
import { captureMeetingAudio, MeetingAudioError } from "@/lib/meetingAudio";
import { connectRealtime, type ProjectContextItem, type RealtimeConnection } from "@/lib/realtime";
import { queryProjectContext } from "@/lib/contextQuery";
import { supabase } from "@/lib/supabase";
import type { VoiceNote } from "@/lib/voiceNoteSchema";

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
  const [contextQuery, setContextQuery] = useState<string | null>(null);
  const [contextItems, setContextItems] = useState<ProjectContextItem[]>([]);
  const [manualQuery, setManualQuery] = useState("Safari login redirect");
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  const [lastNoteCount, setLastNoteCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
    setStatus("loading");
    const fastApiUrl = getFastApiUrl();

    try {
      const activeBriefing = briefing ?? (await fetchBriefing(fastApiUrl));
      setBriefing(activeBriefing);

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
        projectId,
        fastApiUrl,
        queryContext: (query) =>
          queryProjectContext({
            fastApiUrl,
            projectId,
            query,
            k: 6,
        }),
        onTranscript: (event) => {
          if (event.type === "completed") {
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
    const fastApiUrl = getFastApiUrl();
    if (!query || !fastApiUrl) return;

    try {
      const items = await queryProjectContext({
        fastApiUrl,
        projectId,
        query,
        k: 6,
      });
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
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-400">
            Status: {status}
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
              placeholder="Search project context"
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

      {lastNoteCount > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
          Notes inserted: {lastNoteCount}
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
    `Themes: ${(briefing.themes ?? []).map(themeLabel).join(", ")}`,
    `Active files: ${(briefing.active_files ?? []).map(activeFileLabel).filter(Boolean).join(", ")}`,
    "Prefer concise search queries of 3-8 words.",
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
