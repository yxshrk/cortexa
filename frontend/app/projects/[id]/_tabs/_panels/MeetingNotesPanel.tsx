"use client";

import { useEffect, useMemo, useState } from "react";
import { VoiceAgent } from "@/components/VoiceAgent";
import { supabase } from "@/lib/supabase";

type Meeting = {
  id: string;
  project_id: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
};

export default function MeetingNotesPanel({ projectId }: { projectId: string }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );

  useEffect(() => {
    let alive = true;

    async function loadMeetings() {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("meetings")
        .select("id,project_id,title,started_at,ended_at,status")
        .eq("project_id", projectId)
        .order("started_at", { ascending: false });

      if (!alive) return;

      if (fetchError) {
        setError(fetchError.message);
        setMeetings([]);
        setSelectedMeetingId(null);
      } else {
        const rows = (data ?? []) as Meeting[];
        setMeetings(rows);
        setSelectedMeetingId((current) => {
          if (current && rows.some((meeting) => meeting.id === current)) {
            return current;
          }

          return rows.find((meeting) => meeting.status === "live")?.id ?? rows[0]?.id ?? null;
        });
      }

      setLoading(false);
    }

    void loadMeetings();

    const channel = supabase
      .channel(`meetings:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "meetings",
          filter: `project_id=eq.${projectId}`,
        },
        () => {
          void loadMeetings();
        },
      )
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [projectId]);

  return (
    <div className="grid grid-cols-12 gap-4 min-h-[calc(100vh-260px)]">
      {/* Column 1 — meetings list */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3">
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide">
            Meetings
          </h2>
          <button
            onClick={() => {
              setError(
                "Meeting rows are created by backend/setup for now. Ask Jin/Yash to seed a live meeting, then it will appear here.",
              );
            }}
            className="text-xs rounded-md bg-ink-900 text-white px-2 py-1 hover:opacity-90"
            title="Start a new meeting and launch the voice agent"
          >
            + New
          </button>
        </div>
        {loading ? (
          <div className="rounded-lg border border-dashed border-ink-200 p-4 text-center text-ink-400 text-xs">
            Loading meetings...
          </div>
        ) : meetings.length > 0 ? (
          <div className="space-y-2">
            {meetings.map((meeting) => {
              const selected = meeting.id === selectedMeetingId;

              return (
                <button
                  key={meeting.id}
                  onClick={() => setSelectedMeetingId(meeting.id)}
                  className={
                    "w-full rounded-lg border p-3 text-left transition " +
                    (selected
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-200 bg-white text-ink-700 hover:border-ink-400")
                  }
                >
                  <div className="truncate text-sm font-medium">
                    {meeting.title ?? "Untitled meeting"}
                  </div>
                  <div className={selected ? "mt-1 text-xs text-white/60" : "mt-1 text-xs text-ink-400"}>
                    {meeting.status ?? "unknown"} · {formatMeetingTime(meeting.started_at)}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-ink-200 p-4 text-center text-ink-400 text-xs">
            No meetings yet. Seed or create a live meeting to launch the voice agent.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}
      </aside>

      {/* Column 2 — voice agent / notes */}
      <section className="col-span-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3 px-1">
          Voice agent · structured notes
        </h2>
        {selectedMeeting ? (
          <VoiceAgent projectId={projectId} meetingId={selectedMeeting.id} />
        ) : (
          <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
            <div className="text-2xl mb-2">🎙️</div>
            <div className="text-sm font-medium text-ink-600 mb-1">
              Select a meeting to launch the voice agent
            </div>
            <div className="text-xs">
              The voice agent needs an internal Supabase meeting id before it can save notes.
            </div>
          </div>
        )}
      </section>

      {/* Column 3 — live context / chunks */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-2 px-1">
          Live context
        </h2>
        <div className="text-xs text-ink-400 px-1">
          As the agent transcribes, relevant chunks from connectors appear here.
        </div>
      </aside>
    </div>
  );
}

function formatMeetingTime(value: string | null) {
  if (!value) return "no start time";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
