"use client";

import { useState } from "react";
import { FASTAPI_URL, authHeaders } from "@/lib/supabase";

export default function KnowledgeDocTab({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`${FASTAPI_URL}/plan/generate`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId }),
      });
      if (r.status === 409) setMsg("A plan generation is already running.");
      else if (r.ok) setMsg("Generating… synthesis cards will appear via realtime.");
      else setMsg(`Failed: ${r.status} ${await r.text()}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Source banner — make the upstream/downstream flow legible */}
      <div className="rounded-xl border border-ink-200 bg-white p-4 flex items-center gap-3 text-sm">
        <SourceChip icon="🔌" label="Connectors" />
        <span className="text-ink-400">+</span>
        <SourceChip icon="🎙️" label="Meeting Notes" />
        <span className="text-ink-400">+</span>
        <SourceChip icon="🐙" label="Codebase refs" />
        <span className="text-ink-400 mx-1">→</span>
        <SourceChip icon="🧠" label="Knowledge Doc" emphasis />
        <span className="text-ink-400 mx-1">→</span>
        <SourceChip icon="⚡" label="Actions" />
      </div>

      {/* Header + generate */}
      <div className="rounded-xl border border-ink-200 bg-white p-5 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">
            Synthesis run
          </div>
          <h2 className="text-lg font-semibold text-ink-900 mt-0.5">
            Week of {new Date().toLocaleDateString()}
          </h2>
          <p className="text-xs text-ink-400 mt-1">
            Pulls every <code>project_context</code> + <code>meeting_notes</code> row, calls Claude for
            synthesis + categorization, writes <code>knowledge_documents</code> and <code>plan_items</code>.
          </p>
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="rounded-lg bg-ink-900 text-white px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Generating…" : "✨ Generate"}
        </button>
      </div>

      {msg && (
        <div className="text-sm text-ink-600 rounded-md bg-ink-100 px-3 py-2">{msg}</div>
      )}

      {/* Output area */}
      <div className="grid grid-cols-12 gap-4">
        <section className="col-span-7 rounded-xl border border-ink-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3">
            Synthesis cards
          </h3>
          <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-ink-400 text-sm">
            Summary · themes · decisions · blockers · open_questions appear here as Claude streams them
            into <code>knowledge_documents</code>.
          </div>
        </section>
        <section className="col-span-5 rounded-xl border border-ink-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3">
            Plan items
          </h3>
          <ul className="space-y-2 text-sm">
            <PlanCategoryRow icon="🐛" label="bug_fix" hint="From blockers + error chunks" />
            <PlanCategoryRow icon="✨" label="new_feature" hint="From decisions + meeting asks" />
            <PlanCategoryRow icon="🔧" label="maintenance" hint="From open_questions + tech debt" />
          </ul>
        </section>
      </div>
    </div>
  );
}

function SourceChip({ icon, label, emphasis }: { icon: string; label: string; emphasis?: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium " +
        (emphasis ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-600")
      }
    >
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function PlanCategoryRow({ icon, label, hint }: { icon: string; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-dashed border-ink-200 p-3">
      <span className="text-base">{icon}</span>
      <div>
        <code className="text-ink-900 text-xs font-semibold">{label}</code>
        <div className="text-xs text-ink-400 mt-0.5">{hint}</div>
      </div>
    </li>
  );
}
