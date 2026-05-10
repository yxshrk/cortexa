"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Project = {
  id: string;
  name: string;
  repo_url: string | null;
  hyperspell_user_id: string | null;
  created_at: string;
};

function parseRepo(url: string | null): string {
  if (!url) return "";
  try {
    const { pathname } = new URL(url);
    return pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return url;
  }
}

function projectInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const NAV = [
  { label: "Projects",  icon: "◈", active: true },
  { label: "Knowledge", icon: "🧠", active: false },
  { label: "Settings",  icon: "⚙", active: false },
];

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setProjects(data ?? []);
      });
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-ink-50">

      {/* ── Sidebar ── */}
      <aside className="w-[220px] shrink-0 flex flex-col border-r border-ink-200 bg-white">
        {/* Workspace */}
        <div className="px-4 py-4 border-b border-ink-100">
          <div className="flex items-center gap-2.5">
            <div className="h-6 w-6 rounded bg-ink-900 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-bold text-white">C</span>
            </div>
            <span className="text-[13px] font-semibold tracking-[-0.08px] text-ink-900">Cortexa</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map((item) => (
            <div
              key={item.label}
              className={
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100 cursor-default " +
                (item.active
                  ? "bg-ink-100 text-ink-900 font-medium"
                  : "text-ink-500 hover:bg-ink-50 hover:text-ink-900")
              }
            >
              <span className="text-[13px] opacity-60">{item.icon}</span>
              <span>{item.label}</span>
              {item.active && projects && (
                <span className="ml-auto text-[11px] text-ink-400 tabular-nums">
                  {projects.length}
                </span>
              )}
            </div>
          ))}
        </nav>

        {/* User */}
        <div className="px-3 py-3 border-t border-ink-100">
          <div className="flex items-center gap-2.5">
            <div className="h-6 w-6 rounded-full bg-ink-900 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-semibold text-white">N</span>
            </div>
            <span className="text-[12px] text-ink-600 truncate">cortexa workspace</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <header className="flex items-center justify-between px-6 h-11 border-b border-ink-200 bg-white shrink-0">
          <div className="flex items-center gap-2 text-[12px] text-ink-400">
            <span>Cortexa</span>
            <span>/</span>
            <span className="text-ink-900 font-medium">Projects</span>
          </div>
          <div className="text-[11px] text-ink-400 tabular-nums">
            {projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : ""}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">

          {/* Page title */}
          <div className="px-6 pt-6 pb-4">
            <h1 className="text-[20px] font-semibold tracking-[-0.288px] text-ink-900">
              Projects
            </h1>
            <p className="mt-0.5 text-[13px] tracking-[-0.078px] text-ink-500">
              Voice + Hyperspell + Claude → execution.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mx-6 mb-4 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2.5 text-[12px] tracking-[-0.072px] text-rose-700">
              {error}
            </div>
          )}

          {/* Column headers */}
          {projects && projects.length > 0 && (
            <div className="px-6 mb-1">
              <div className="grid grid-cols-[1fr_140px_100px_80px] gap-4 px-3 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">Name</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">Repository</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">Status</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">Created</span>
              </div>
            </div>
          )}

          {/* Loading */}
          {projects === null && !error && (
            <div className="px-6 space-y-px">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-md border border-transparent px-3 py-2.5 animate-pulse">
                  <div className="grid grid-cols-[1fr_140px_100px_80px] gap-4 items-center">
                    <div className="flex items-center gap-2.5">
                      <div className="h-5 w-5 rounded bg-ink-100 shrink-0" />
                      <div className="h-3 bg-ink-100 rounded w-32" />
                    </div>
                    <div className="h-2.5 bg-ink-100 rounded w-24" />
                    <div className="h-4 bg-ink-100 rounded w-16" />
                    <div className="h-2.5 bg-ink-100 rounded w-12" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty */}
          {projects && projects.length === 0 && (
            <div className="mx-6 rounded-lg border border-dashed border-ink-200 bg-white p-10 text-center">
              <p className="text-[13px] text-ink-500 mb-1">No projects yet.</p>
              <p className="text-[12px] text-ink-400">Insert a row in Supabase and refresh.</p>
            </div>
          )}

          {/* Project rows — Linear-style dense list */}
          {projects && projects.length > 0 && (
            <div className="px-6 pb-6 space-y-px">
              {projects.map((p) => {
                const repo = parseRepo(p.repo_url);
                const initials = projectInitials(p.name);
                const hasHyperspell = !!p.hyperspell_user_id;

                return (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="group grid grid-cols-[1fr_140px_100px_80px] gap-4 items-center rounded-md border border-transparent px-3 py-2.5 hover:border-ink-200 hover:bg-white transition-all duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1"
                  >
                    {/* Name + avatar */}
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-5 w-5 rounded bg-ink-900 text-white flex items-center justify-center text-[9px] font-semibold shrink-0 select-none">
                        {initials}
                      </div>
                      <span className="text-[13px] font-medium tracking-[-0.078px] text-ink-900 truncate">
                        {p.name}
                      </span>
                    </div>

                    {/* Repo */}
                    <span className="text-[12px] tracking-[-0.072px] text-ink-400 font-mono truncate">
                      {repo || "—"}
                    </span>

                    {/* Status */}
                    {hasHyperspell ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-[-0.066px] text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                        Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-[-0.066px] text-ink-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-ink-300 shrink-0" />
                        No sync
                      </span>
                    )}

                    {/* Date */}
                    <span className="text-[11px] tracking-[-0.066px] text-ink-400 tabular-nums">
                      {p.created_at ? formatDate(p.created_at) : "—"}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
