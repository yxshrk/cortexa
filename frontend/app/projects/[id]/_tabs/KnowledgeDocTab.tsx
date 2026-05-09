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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Week of {new Date().toLocaleDateString()}</h2>
        <button
          onClick={generate}
          disabled={busy}
          className="rounded-lg bg-ink-900 text-white px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Generating…" : "✨ Generate plan"}
        </button>
      </div>
      {msg && <div className="text-sm text-ink-400">{msg}</div>}
      <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
        <div className="text-lg mb-1">🧠 Knowledge Doc tab — Jin owns this</div>
        <div className="text-sm">
          Renders synthesis cards (summary / themes / decisions / blockers / open_questions) and{" "}
          plan items grouped by category (🐛 bug_fix / ✨ new_feature / 🔧 maintenance) from{" "}
          <code>knowledge_documents</code> + <code>plan_items</code> via Supabase realtime.
        </div>
      </div>
    </div>
  );
}
