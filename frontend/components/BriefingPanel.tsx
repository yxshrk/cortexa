"use client";

export type Briefing = {
  id?: string;
  project_summary?: string;
  themes?: string[];
  recent_decisions?: { summary?: string }[];
  open_threads?: { label?: string; source?: string; count?: number }[];
  latest_docs?: { title?: string; url?: string }[];
  active_files?: { path?: string; last_touched?: string }[];
  people?: string[];
};

export function BriefingPanel({ briefing }: { briefing: Briefing | null }) {
  if (!briefing) {
    return (
      <section className="rounded-lg border border-dashed border-ink-200 p-4 text-sm text-ink-400">
        Briefing not loaded yet.
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-ink-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-ink-900">Project Briefing</h3>
      <p className="mt-2 text-sm text-ink-600">
        {briefing.project_summary ?? "No project summary available."}
      </p>
      {briefing.themes && briefing.themes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {briefing.themes.map((theme) => (
            <span key={theme} className="rounded-full bg-ink-100 px-2 py-1 text-xs text-ink-600">
              {theme}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
