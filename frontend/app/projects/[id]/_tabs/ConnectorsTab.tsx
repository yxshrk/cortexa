"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CONNECTORS, ConnectorId, FASTAPI_URL, authHeaders, supabase } from "@/lib/supabase";

type ProjectContext = {
  id: string;
  project_id: string;
  source: ConnectorId;
  external_id: string | null;
  title: string | null;
  snippet: string | null;
  full_text: string | null;
  author: string | null;
  ref_url: string | null;
  embedding: number[] | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  ts: string;
};

type ConnStatus = "connected" | "not_connected" | "beta";

export default function ConnectorsTab({ projectId }: { projectId: string }) {
  const [statuses, setStatuses] = useState<Record<string, ConnStatus> | null>(null);
  const [docs, setDocs] = useState<ProjectContext[]>([]);
  const [selectedSource, setSelectedSource] = useState<ConnectorId>("slack");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial load + realtime subscription on project_context
  useEffect(() => {
    setLoading(true);
    supabase
      .from("project_context")
      .select("*")
      .eq("project_id", projectId)
      .order("ts", { ascending: false })
      .then(({ data }) => {
        setDocs((data ?? []) as ProjectContext[]);
        setLoading(false);
      });

    const channel = supabase
      .channel(`pc:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_context", filter: `project_id=eq.${projectId}` },
        (p) => {
          setDocs((prev) => {
            if (p.eventType === "INSERT") return [p.new as ProjectContext, ...prev];
            if (p.eventType === "UPDATE")
              return prev.map((d) => (d.id === (p.new as ProjectContext).id ? (p.new as ProjectContext) : d));
            if (p.eventType === "DELETE")
              return prev.filter((d) => d.id !== (p.old as ProjectContext).id);
            return prev;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  // Connection status from Yash's /connect/status (with heuristic fallback)
  useEffect(() => {
    fetch(`${FASTAPI_URL}/connect/status?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setStatuses)
      .catch(() => {
        // Fallback heuristic: presence of any project_context row of a source ⇒ connected.
        const seen = new Set(docs.map((d) => d.source));
        setStatuses({
          slack: seen.has("slack") ? "connected" : "not_connected",
          drive: seen.has("drive") ? "connected" : "not_connected",
          notion: seen.has("notion") ? "connected" : "not_connected",
          gmail: seen.has("gmail") ? "connected" : "not_connected",
          github: "beta",
        });
      });
  }, [projectId, docs.length]);

  const docsForSource = useMemo(
    () => docs.filter((d) => d.source === selectedSource),
    [docs, selectedSource],
  );
  const selectedDoc = docsForSource.find((d) => d.id === selectedDocId) ?? docsForSource[0];

  // Track in-flight ingest so the popup-watcher and the "just_connected"
  // bootstrap path never double-fire.
  const ingestInFlight = useRef(false);

  async function refreshIngest() {
    if (ingestInFlight.current) return;
    ingestInFlight.current = true;
    try {
      await fetch(`${FASTAPI_URL}/ingest/hyperspell`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId }),
      });
    } finally {
      ingestInFlight.current = false;
    }
  }

  async function startConnect(source: ConnectorId) {
    // Pre-open the popup SYNCHRONOUSLY inside the click handler. Browsers
    // (especially Safari) block window.open() called after an `await`, because
    // popups must originate from a direct user gesture. We open about:blank
    // now and navigate it to the OAuth URL once we have it.
    //
    // NOTE: no `noopener` — we keep the handle so we can poll `popup.closed`
    // and auto-fire ingestion when OAuth finishes.
    const popup = window.open("about:blank", "_blank");

    // Where Hyperspell sends the user after OAuth. Hits a tiny page that
    // closes itself; meanwhile this tab's polling loop fires the ingest.
    const redirectUrl = `${window.location.origin}/connect/return?projectId=${encodeURIComponent(projectId)}&source=${encodeURIComponent(source)}`;

    try {
      const r = await fetch(`${FASTAPI_URL}/connect/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId, source, redirectUrl }),
      });
      if (!r.ok) {
        popup?.close();
        alert(`Connect failed: ${r.status} ${await r.text()}`);
        return;
      }
      const { url } = await r.json();
      if (!url) {
        popup?.close();
        return;
      }
      if (popup && !popup.closed) {
        popup.location.href = url;
        watchPopupAndIngest(popup, source);
      } else {
        // Popup blocked → same-tab redirect. The /connect/return page will
        // POST the ingest and bounce the user back to /projects/<id>.
        window.location.href = url;
      }
    } catch (e) {
      popup?.close();
      alert(`Connect error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Poll for popup close; once it closes, fire one ingest. Times out after
  // 10 minutes so we don't leak the interval if the user wanders off.
  function watchPopupAndIngest(popup: Window, _source: ConnectorId) {
    const start = Date.now();
    const iv = window.setInterval(() => {
      const closed = (() => {
        try {
          return popup.closed;
        } catch {
          // Cross-origin access throws while OAuth is on Hyperspell's domain.
          // Treat as "still open" — `popup.closed` is the one property browsers
          // expose across origins, but some configurations still throw.
          return false;
        }
      })();
      if (closed) {
        window.clearInterval(iv);
        void refreshIngest();
      } else if (Date.now() - start > 10 * 60_000) {
        window.clearInterval(iv);
      }
    }, 750);
  }

  return (
    <div className="grid grid-cols-12 gap-4 min-h-[calc(100vh-180px)]">
      {/* Column 1 — Connectors */}
      <aside className="col-span-3 rounded-xl border border-ink-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2 px-1">
          <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide">
            Connectors
          </h2>
          <button
            onClick={refreshIngest}
            className="text-xs text-ink-400 hover:text-ink-900"
            title="Force /ingest/hyperspell"
          >
            🔄
          </button>
        </div>
        <ul className="space-y-1">
          {CONNECTORS.map((c) => {
            const status = statuses?.[c.id] ?? "not_connected";
            const active = selectedSource === c.id;
            return (
              <li key={c.id}>
                <button
                  onClick={() => {
                    setSelectedSource(c.id);
                    setSelectedDocId(null);
                  }}
                  className={
                    "w-full text-left rounded-lg px-3 py-2 flex items-center justify-between transition " +
                    (active
                      ? "bg-ink-900 text-white"
                      : "hover:bg-ink-100 text-ink-900")
                  }
                >
                  <span className="flex items-center gap-2">
                    <span>{c.emoji}</span>
                    <span className="font-medium">{c.label}</span>
                  </span>
                  <StatusPill status={status} dark={active} />
                </button>
              </li>
            );
          })}
        </ul>
        {(() => {
          const c = CONNECTORS.find((x) => x.id === selectedSource);
          // `unsupported` (e.g. gmail) — Hyperspell doesn't expose it.
          // `beta` (e.g. github) — used for code_refs in /plan/generate, not the connect flow.
          const disabled = c && ("unsupported" in c || "beta" in c);
          const tooltip =
            c && "tooltip" in c && typeof c.tooltip === "string" ? c.tooltip : undefined;
          return (
            <button
              onClick={() => startConnect(selectedSource)}
              disabled={disabled}
              title={tooltip}
              className={
                "mt-3 w-full rounded-lg border border-dashed px-3 py-2 text-sm transition " +
                (disabled
                  ? "border-ink-200 text-ink-400 cursor-not-allowed opacity-60"
                  : "border-ink-200 text-ink-400 hover:text-ink-900 hover:border-ink-400")
              }
            >
              {disabled
                ? `${c?.label} — ${("unsupported" in (c ?? {})) ? "not supported by Hyperspell" : "beta (used in plan generation)"}`
                : `+ Connect ${c?.label}`}
            </button>
          );
        })()}
      </aside>

      {/* Column 2 — Documents */}
      <section className="col-span-5 rounded-xl border border-ink-200 bg-white p-3">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-2 px-1">
          Documents ({docsForSource.length})
        </h2>
        {loading && <div className="text-ink-400 text-sm">Loading…</div>}
        {!loading && docsForSource.length === 0 && (
          <EmptyDocs onIngest={refreshIngest} source={selectedSource} />
        )}
        <ul className="space-y-2">
          {docsForSource.map((d) => {
            const active = (selectedDoc?.id ?? null) === d.id;
            return (
              <li key={d.id}>
                <button
                  onClick={() => setSelectedDocId(d.id)}
                  className={
                    "w-full text-left rounded-lg border p-3 transition " +
                    (active
                      ? "border-ink-900 bg-ink-50"
                      : "border-ink-200 hover:border-ink-400")
                  }
                >
                  <div className="flex items-center gap-2 mb-1">
                    <SourceBadge source={d.source} />
                    {d.embedding && <span title="embedded" className="text-emerald-600 text-xs">✓ embedded</span>}
                  </div>
                  <div className="font-medium truncate">{d.title ?? d.snippet?.slice(0, 60) ?? "(untitled)"}</div>
                  <div className="text-xs text-ink-400 truncate">
                    {d.author ? `${d.author} · ` : ""}
                    {new Date(d.source_updated_at ?? d.ts).toLocaleString()}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Column 3 — Chunks / Detail */}
      <aside className="col-span-4 rounded-xl border border-ink-200 bg-white p-3">
        <h2 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-2 px-1">
          Chunks · Detail
        </h2>
        {!selectedDoc && (
          <div className="text-ink-400 text-sm p-2">Select a document.</div>
        )}
        {selectedDoc && (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-ink-400">Title</div>
              <div className="font-medium">{selectedDoc.title ?? "(untitled)"}</div>
            </div>
            {selectedDoc.ref_url && (
              <div>
                <div className="text-xs text-ink-400">Source URL</div>
                <a href={selectedDoc.ref_url} target="_blank" rel="noreferrer"
                   className="text-sm text-blue-600 hover:underline break-all">
                  {selectedDoc.ref_url}
                </a>
              </div>
            )}
            <div>
              <div className="text-xs text-ink-400 mb-1">Snippet</div>
              <p className="text-sm text-ink-600">{selectedDoc.snippet}</p>
            </div>
            <div>
              <div className="text-xs text-ink-400 mb-1">Full text</div>
              <pre className="text-xs whitespace-pre-wrap bg-ink-100 rounded p-2 max-h-72 overflow-auto">
                {selectedDoc.full_text ?? "(not stored)"}
              </pre>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-ink-400">
              <div><span className="block">external_id</span><code className="text-ink-600">{selectedDoc.external_id ?? "—"}</code></div>
              <div><span className="block">embedding</span><code className="text-ink-600">{selectedDoc.embedding ? `vec(${selectedDoc.embedding.length})` : "—"}</code></div>
              <div><span className="block">source_created_at</span><code className="text-ink-600">{selectedDoc.source_created_at ?? "—"}</code></div>
              <div><span className="block">source_updated_at</span><code className="text-ink-600">{selectedDoc.source_updated_at ?? "—"}</code></div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function StatusPill({ status, dark }: { status: ConnStatus; dark: boolean }) {
  const cfg = {
    connected:     { label: "✓",   cls: "bg-emerald-100 text-emerald-700" },
    not_connected: { label: "—",   cls: "bg-ink-100 text-ink-400" },
    beta:          { label: "β",   cls: "bg-amber-100 text-amber-700" },
  }[status];
  return (
    <span className={"text-xs px-2 py-0.5 rounded-full " + (dark ? "bg-white/10 text-white" : cfg.cls)}>
      {cfg.label}
    </span>
  );
}

function SourceBadge({ source }: { source: ConnectorId }) {
  const c = CONNECTORS.find((x) => x.id === source);
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-100 text-ink-400 font-semibold">
      {c?.emoji} {c?.label}
    </span>
  );
}

function EmptyDocs({ onIngest, source }: { onIngest: () => void; source: ConnectorId }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 p-6 text-center text-ink-400">
      <div className="mb-2">No {source} documents indexed yet.</div>
      <button
        onClick={onIngest}
        className="text-sm rounded-md bg-ink-900 text-white px-3 py-1.5 hover:opacity-90"
      >
        Pull from Hyperspell
      </button>
      <div className="text-xs mt-2">
        Calls <code>POST /ingest/hyperspell</code> on your FastAPI.
      </div>
    </div>
  );
}
