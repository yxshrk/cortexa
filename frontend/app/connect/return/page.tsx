"use client";

import { useEffect, useState } from "react";
import { FASTAPI_URL, authHeaders } from "@/lib/supabase";

type State =
  | { kind: "working"; msg: string }
  | { kind: "error"; headline: string; detail: string; hint: string | null };

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

export default function ConnectReturnPage() {
  const [state, setState] = useState<State>({ kind: "working", msg: "Finishing connection…" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("projectId");
    const source = params.get("source");
    const isPopup = window.opener && !window.opener.closed;

    // Popup path: opener watches `popup.closed` and fires the ingest itself,
    // so just close. Same-tab fallback: fire the ingest here, then bounce.
    (async () => {
      if (isPopup) {
        setState({ kind: "working", msg: "Connected. Closing…" });
        window.close();
        return;
      }

      if (!projectId) {
        setState({ kind: "working", msg: "Connected." });
        return;
      }

      try {
        const r = await fetch(`${FASTAPI_URL}/ingest/hyperspell`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ projectId }),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          const detail = extractDetail(text) || r.statusText;
          const headline =
            r.status === 401
              ? "Backend rejected demo token"
              : r.status >= 500
                ? "Backend error during ingest"
                : `Ingest failed (${r.status})`;
          const hint =
            r.status === 401
              ? "Set NEXT_PUBLIC_DEMO_TOKEN to match the backend's DEMO_TOKEN, then reload."
              : null;
          setState({ kind: "error", headline, detail, hint });
          return;
        }
      } catch (e) {
        setState({
          kind: "error",
          headline: "Couldn't reach backend",
          detail: e instanceof Error ? e.message : String(e),
          hint: `Is FASTAPI_URL (${FASTAPI_URL}) reachable?`,
        });
        return;
      }
      window.location.href = `/projects/${projectId}?just_connected=${encodeURIComponent(source ?? "")}`;
    })();
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-ink-50">
      <div className="rounded-xl border border-ink-200 bg-white p-6 text-center max-w-md">
        {state.kind === "working" && (
          <>
            <div className="text-2xl mb-2">✓</div>
            <div className="text-ink-900 font-medium">{state.msg}</div>
            <div className="text-xs text-ink-400 mt-2">You can close this window.</div>
          </>
        )}
        {state.kind === "error" && (
          <>
            <div className="text-2xl mb-2">⚠️</div>
            <div className="text-rose-700 font-medium">{state.headline}</div>
            <div className="text-xs text-ink-600 mt-2 break-words">{state.detail}</div>
            {state.hint && <div className="text-xs text-ink-400 mt-2">{state.hint}</div>}
          </>
        )}
      </div>
    </main>
  );
}
