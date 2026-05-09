"use client";

import { useEffect, useMemo, useState } from "react";
import { CONNECTORS, ConnectorId, FASTAPI_URL, supabase } from "@/lib/supabase";

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

  async function startConnect(source: ConnectorId) {
    // Pre-open the window SYNCHRONOUSLY inside the click handler. Browsers
    // (especially Safari) block window.open() called after an async await,
    // because they only permit popups in direct response to a user gesture.
    // We open about:blank now and redirect it once we have the OAuth URL.
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");

    try {
      const r = await fetch(`${FASTAPI_URL}/connect/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.NEXT_PUBLIC_DEMO_TOKEN ?? ""}`,
        },
        body: JSON.stringify({ projectId, source }),
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
      } else {
        // Popup was blocked despite synchronous open — fall back to same-tab redirect.
        window.location.href = url;
      }
    } catch (e) {
      popup?.close();
      alert(`Connect error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function refreshIngest() {
    await fetch(`${FASTAPI_URL}/ingest/hyperspell`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.NEXT_PUBLIC_DEMO_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ projectId }),
    });
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
        <button
          onClick={() => startConnect(selectedSource)}
          className="mt-3 w-full rounded-lg border border-dashed border-ink-200 px-3 py-2 text-sm text-ink-400 hover:text-ink-900 hover:border-ink-400"
        >
          + Connect {CONNECTORS.find((c) => c.id === selectedSource)?.label}
        </button>
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
