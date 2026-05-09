"use client";

import { useEffect, useState } from "react";
import { FASTAPI_URL, authHeaders } from "@/lib/supabase";

export default function ConnectReturnPage() {
  const [msg, setMsg] = useState("Finishing connection…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("projectId");
    const source = params.get("source");
    const isPopup = window.opener && !window.opener.closed;

    // The opener tab's popup-watcher polls `popup.closed` and fires the ingest
    // itself, so when we're in the popup we just close. The same-tab fallback
    // (popup blocked) needs us to fire the ingest here, then send the user
    // back to the project page.
    (async () => {
      if (isPopup) {
        setMsg("Connected. Closing…");
        window.close();
        return;
      }

      if (!projectId) {
        setMsg("Connected.");
        return;
      }

      try {
        await fetch(`${FASTAPI_URL}/ingest/hyperspell`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ projectId }),
        });
      } catch {
        // Ingest is best-effort; the user can hit "Pull from Hyperspell" if it failed.
      }
      window.location.href = `/projects/${projectId}?just_connected=${encodeURIComponent(source ?? "")}`;
    })();
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-ink-50">
      <div className="rounded-xl border border-ink-200 bg-white p-6 text-center">
        <div className="text-2xl mb-2">✓</div>
        <div className="text-ink-900 font-medium">{msg}</div>
        <div className="text-xs text-ink-400 mt-2">You can close this window.</div>
      </div>
    </main>
  );
}
