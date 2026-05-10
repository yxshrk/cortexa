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
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">🧠 Project Brain</h1>
        <p className="text-ink-400">
          Per-project pipeline · voice + Hyperspell + Claude → execution.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}. Check that <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are set in{" "}
          <code>.env.local</code>, and that the schema migration has run.
        </div>
      )}

      {projects === null && !error && (
        <div className="text-ink-400">Loading…</div>
      )}

      {projects && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-ink-400">
          No projects yet. Insert one in Supabase and refresh.
          <pre className="mt-4 whitespace-pre-wrap text-left text-xs text-ink-600 bg-ink-100 rounded p-3">
{`insert into projects (name, repo_url, hyperspell_user_id)
values ('Demo', 'https://github.com/<owner>/<repo>', 'pri-demo');`}
          </pre>
        </div>
      )}

      <ul className="space-y-3">
        {projects?.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="block rounded-xl border border-ink-200 bg-white p-5 hover:border-ink-400 transition"
            >
              <div className="text-lg font-semibold">{p.name}</div>
              {p.repo_url && (
                <div className="text-sm text-ink-400 truncate">{p.repo_url}</div>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
