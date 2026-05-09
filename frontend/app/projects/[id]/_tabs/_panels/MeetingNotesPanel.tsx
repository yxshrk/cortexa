"use client";

export default function MeetingNotesPanel({ projectId: _ }: { projectId: string }) {
  return (
    <div className="grid grid-cols-12 gap-4 min-h-[calc(100vh-260px)]">
      {/* Column 1 — meetings list */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3">
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide">
            Meetings
          </h2>
          <button
            className="text-xs rounded-md bg-ink-900 text-white px-2 py-1 hover:opacity-90"
            title="Start a new meeting and launch the voice agent"
          >
            + New
          </button>
        </div>
        <div className="rounded-lg border border-dashed border-ink-200 p-4 text-center text-ink-400 text-xs">
          No meetings yet. Start one to launch the voice agent.
        </div>
      </aside>

      {/* Column 2 — voice agent / notes */}
      <section className="col-span-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3 px-1">
          Voice agent · structured notes
        </h2>
        <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
          <div className="text-2xl mb-2">🎙️</div>
          <div className="text-sm font-medium text-ink-600 mb-1">
            Yudong&apos;s voice agent mounts here
          </div>
          <div className="text-xs">
            Select a meeting to load <code>&lt;VoiceAgent /&gt;</code>. Live transcript on the right,
            structured notes (decisions / blockers / open questions) accumulate as you talk.
          </div>
        </div>
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
