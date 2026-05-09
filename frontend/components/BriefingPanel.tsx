"use client";

export type Briefing = {
  id?: string;
  project_summary?: string;
  themes?: (string | { label?: string; count?: number })[];
  recent_decisions?: { summary?: string }[];
  open_threads?: { label?: string; source?: string; count?: number }[];
  latest_docs?: { title?: string; url?: string }[];
  active_files?: { path?: string; title?: string; last_touched?: string; updated_at?: string }[];
  people?: (string | { name?: string; mentions?: number })[];
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
            <span key={themeLabel(theme)} className="rounded-full bg-ink-100 px-2 py-1 text-xs text-ink-600">
              {themeLabel(theme)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function themeLabel(theme: string | { label?: string; count?: number }) {
  if (typeof theme === "string") return theme;
  return theme.count ? `${theme.label ?? "Theme"} (${theme.count})` : theme.label ?? "Theme";
}

export function activeFileLabel(file: { path?: string; title?: string }) {
  return file.path ?? file.title ?? "";
}
