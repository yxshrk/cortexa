"use client";

import { useEffect, useMemo, useState } from "react";
import { VoiceAgent } from "@/components/VoiceAgent";
import { FASTAPI_URL, authHeaders, supabase } from "@/lib/supabase";

type MeetingStatus = "live" | "ended";

type Meeting = {
  id: string;
  project_id: string;
  title: string | null;
  status: MeetingStatus;
  started_at: string | null;
  ended_at: string | null;
};

type MeetingNote = {
  id: string;
  meeting_id: string | null;
  project_id: string;
  type: "decision" | "action_item" | "blocker" | "mention" | "fyi";
  text: string;
  embedding: number[] | string | null;
  ts: string;
};

const NOTE_TYPE_TONE: Record<MeetingNote["type"], string> = {
  decision: "border-emerald-200 bg-emerald-50 text-emerald-900",
  action_item: "border-violet-200 bg-violet-50 text-violet-900",
  blocker: "border-rose-200 bg-rose-50 text-rose-900",
  mention: "border-cyan-200 bg-cyan-50 text-cyan-900",
  fyi: "border-ink-200 bg-ink-50 text-ink-900",
};

const NOTE_TYPE_EMOJI: Record<MeetingNote["type"], string> = {
  decision: "✅",
  action_item: "📌",
  blocker: "🚧",
  mention: "💬",
  fyi: "ℹ️",
};

export default function MeetingNotesPanel({ projectId }: { projectId: string }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load + realtime
  useEffect(() => {
    let alive = true;
    void Promise.all([
      supabase
        .from("meetings")
        .select("*")
        .eq("project_id", projectId)
        .order("started_at", { ascending: false })
        .limit(50),
      supabase
        .from("meeting_notes")
        .select("*")
        .eq("project_id", projectId)
        .order("ts", { ascending: false })
        .limit(200),
    ]).then(([m, n]) => {
      if (!alive) return;
      const list = (m.data ?? []) as Meeting[];
      setMeetings(list);
      setNotes((n.data ?? []) as MeetingNote[]);
      // Auto-select the latest live meeting if any, else the most recent.
      setSelectedMeetingId((prev) => {
        if (prev) return prev;
        const live = list.find((x) => x.status === "live");
        return live?.id ?? list[0]?.id ?? null;
      });
    });

    const channel = supabase
      .channel(`meetings:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "meetings", filter: `project_id=eq.${projectId}` },
        (p) => setMeetings((prev) => mergeRow<Meeting>(prev, p)),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "meeting_notes", filter: `project_id=eq.${projectId}` },
        (p) => setNotes((prev) => mergeRow<MeetingNote>(prev, p)),
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );
  const notesForMeeting = useMemo(
    () =>
      selectedMeeting
        ? notes
            .filter((n) => n.meeting_id === selectedMeeting.id)
            .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
        : [],
    [notes, selectedMeeting],
  );

  async function startMeeting() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${FASTAPI_URL}/meetings/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        setError(`Couldn't start meeting (${r.status}): ${extractDetail(text)}`);
        return;
      }
      const meeting = (await r.json()) as Meeting;
      setMeetings((prev) =>
        prev.some((m) => m.id === meeting.id) ? prev : [meeting, ...prev],
      );
      setSelectedMeetingId(meeting.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function endMeeting(meeting: Meeting) {
    if (busy || meeting.status === "ended") return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${FASTAPI_URL}/meetings/${meeting.id}/end`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        setError(`Couldn't end meeting: ${extractDetail(text)}`);
        return;
      }
      const updated = (await r.json()) as Meeting;
      // `meetings` isn't in the supabase_realtime publication, so we won't
      // get an UPDATE event for free — patch the row in local state.
      setMeetings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4 min-h-[calc(100vh-260px)]">
      {/* Column 1 — meetings list */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3 flex flex-col">
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide">
            Meetings · {meetings.length}
          </h2>
          <button
            onClick={startMeeting}
            disabled={busy}
            className="text-xs rounded-md bg-ink-900 text-white px-2 py-1 hover:opacity-90 disabled:opacity-50"
            title="Start a new meeting and launch the voice agent"
          >
            {busy ? "…" : "+ New"}
          </button>
        </div>

        {error && (
          <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-800">
            {error}
          </div>
        )}

        {meetings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-200 p-4 text-center text-ink-400 text-xs">
            No meetings yet. Click <strong>+ New</strong> to start one and launch the voice agent.
          </div>
        ) : (
          <ul className="space-y-1 overflow-y-auto">
            {meetings.map((m) => {
              const active = selectedMeetingId === m.id;
              return (
                <li key={m.id}>
                  <button
                    onClick={() => setSelectedMeetingId(m.id)}
                    className={
                      "w-full text-left rounded-lg px-3 py-2 transition flex items-start gap-2 " +
                      (active ? "bg-ink-900 text-white" : "hover:bg-ink-100 text-ink-900")
                    }
                  >
                    <span className="mt-0.5 inline-flex items-center gap-1">
                      <MeetingStatusDot status={m.status} dark={active} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        {m.title ?? "(untitled)"}
                      </span>
                      <span
                        className={
                          "block text-[11px] truncate " +
                          (active ? "text-white/60" : "text-ink-400")
                        }
                      >
                        {m.started_at
                          ? new Date(m.started_at).toLocaleString()
                          : "—"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* Column 2 — voice agent */}
      <section className="col-span-6 min-w-0">
        {!selectedMeeting ? (
          <div className="rounded-xl border border-dashed border-ink-200 bg-white p-10 text-center text-ink-400">
            <div className="text-2xl mb-2">🎙️</div>
            <div className="text-sm font-medium text-ink-600 mb-1">
              No meeting selected
            </div>
            <div className="text-xs">
              Click <strong>+ New</strong> to start one. The voice agent will
              capture audio, transcribe, and write structured meeting notes.
            </div>
          </div>
        ) : (
          <VoiceAgent
            key={selectedMeeting.id}
            projectId={projectId}
            meetingId={selectedMeeting.id}
          />
        )}
        {selectedMeeting && selectedMeeting.status === "live" && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => endMeeting(selectedMeeting)}
              disabled={busy}
              className="text-xs rounded-md border border-ink-200 px-3 py-1.5 text-ink-600 hover:text-rose-700 hover:border-rose-300 disabled:opacity-50"
            >
              End meeting
            </button>
          </div>
        )}
      </section>

      {/* Column 3 — live notes for the selected meeting */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3 flex flex-col">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-2 px-1">
          Notes · {notesForMeeting.length}
        </h2>
        {!selectedMeeting ? (
          <div className="text-xs text-ink-400 px-1">Select a meeting to see its notes.</div>
        ) : notesForMeeting.length === 0 ? (
          <div className="text-xs text-ink-400 px-1">
            No notes yet. They'll appear here as the agent transcribes and summarizes.
          </div>
        ) : (
          <ul className="space-y-2 overflow-y-auto">
            {notesForMeeting.map((n) => (
              <li
                key={n.id}
                className={`rounded-lg border ${NOTE_TYPE_TONE[n.type]} p-2 text-xs`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span>{NOTE_TYPE_EMOJI[n.type]}</span>
                  <code className="text-[10px] uppercase tracking-wider font-semibold">
                    {n.type}
                  </code>
                  <span className="ml-auto text-[10px] opacity-70 tabular-nums">
                    {new Date(n.ts).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                </div>
                <div className="leading-snug">{n.text}</div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function MeetingStatusDot({
  status,
  dark,
}: {
  status: MeetingStatus;
  dark?: boolean;
}) {
  if (status === "live") {
    return (
      <span className="relative inline-block h-2 w-2">
        <span className="absolute inset-0 rounded-full bg-emerald-500 animate-pulse" />
      </span>
    );
  }
  return (
    <span
      className={
        "inline-block h-2 w-2 rounded-full " + (dark ? "bg-white/40" : "bg-ink-300")
      }
    />
  );
}

function mergeRow<T extends { id: string }>(
  prev: T[],
  payload: { eventType: string; new?: unknown; old?: unknown },
): T[] {
  const isObj = (v: unknown): v is T =>
    !!v && typeof v === "object" && "id" in (v as Record<string, unknown>);
  if (payload.eventType === "INSERT") {
    if (!isObj(payload.new)) return prev;
    const row = payload.new;
    if (prev.some((p) => p.id === row.id)) return prev;
    return [row, ...prev];
  }
  if (payload.eventType === "UPDATE") {
    if (!isObj(payload.new)) return prev;
    const row = payload.new;
    return prev.map((p) => (p.id === row.id ? row : p));
  }
  if (payload.eventType === "DELETE") {
    if (!isObj(payload.old)) return prev;
    const row = payload.old;
    return prev.filter((p) => p.id !== row.id);
  }
  return prev;
}

function extractDetail(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object")
        return (detail as { message?: string }).message ?? JSON.stringify(detail);
    }
  } catch {
    /* not JSON */
  }
  return text.slice(0, 240);
}
