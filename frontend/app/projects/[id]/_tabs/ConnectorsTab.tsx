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

type IngestSourceTextMetric = {
  rows?: number;
  avg_full_chars?: number;
  avg_embedding_chars?: number;
  avg_chunks_total?: number;
  avg_chunks_selected?: number;
  truncated_rows?: number;
  short_rows?: number;
};

type IngestMetrics = {
  documents_total?: number;
  chunks_total?: number;
  chunks_selected_total?: number;
  chunks_selected_ratio?: number;
  by_source_text?: Record<string, IngestSourceTextMetric>;
};

type IngestResult =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; upserted: number; inserted: number; updated: number; sources: Record<string, number>; sourceErrors: Record<string, string>; writeErrors: number; metrics?: IngestMetrics; at: number }
  | { kind: "error"; status?: number; message: string; at: number };

type IngestProgressEvent = {
  ts?: string;
  phase?: "load" | "embed" | "upsert" | "finalize" | string;
  kind?: "start" | "progress" | "end" | "info" | "reasoning" | "error";
  message?: string;
  percent?: number | null;
  extra?: Record<string, unknown>;
};

type IngestRun = {
  id: string;
  project_id: string;
  kind?: "plan" | "ingest" | string;
  status: "queued" | "running" | "ready" | "error";
  error: string | null;
  progress: IngestProgressEvent[] | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

const INGEST_PHASE_LABEL: Record<string, string> = {
  load: "📥 Pulling from Hyperspell",
  embed: "🧬 Chunking + embedding",
  upsert: "💾 Writing to project_context",
  finalize: "✅ Finalizing",
};

export default function ConnectorsTab({ projectId }: { projectId: string }) {
  const [statuses, setStatuses] = useState<Record<string, ConnStatus> | null>(null);
  const [docs, setDocs] = useState<ProjectContext[]>([]);
  const [selectedSource, setSelectedSource] = useState<ConnectorId>("slack");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ingestResult, setIngestResult] = useState<IngestResult>({ kind: "idle" });
  const [ingestRuns, setIngestRuns] = useState<IngestRun[]>([]);

  // Initial load + realtime subscription on project_context + ingest runs
  useEffect(() => {
    setLoading(true);
    void Promise.all([
      supabase
        .from("project_context")
        .select("*")
        .eq("project_id", projectId)
        .order("ts", { ascending: false }),
      supabase
        .from("generation_runs")
        .select("*")
        .eq("project_id", projectId)
        .eq("kind", "ingest")
        .order("created_at", { ascending: false })
        .limit(10),
    ]).then(([d, r]) => {
      setDocs((d.data ?? []) as ProjectContext[]);
      setIngestRuns((r.data ?? []) as IngestRun[]);
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
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generation_runs", filter: `project_id=eq.${projectId}` },
        (p) => {
          // Realtime can't filter on `kind`; do it client-side.
          const row = (p.new ?? p.old) as IngestRun | undefined;
          if (!row || row.kind !== "ingest") return;
          setIngestRuns((prev) => mergeIngestRow(prev, p));
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
  const chunkPreview = useMemo(
    () => buildChunkPreview(selectedDoc?.full_text ?? null),
    [selectedDoc?.id, selectedDoc?.full_text],
  );

  // Active ingest run (if any) + last completed for fallback metrics.
  const activeIngestRun = useMemo(
    () => ingestRuns.find((r) => r.status === "running" || r.status === "queued") ?? null,
    [ingestRuns],
  );
  const lastReadyIngestRun = useMemo(
    () => ingestRuns.find((r) => r.status === "ready") ?? null,
    [ingestRuns],
  );
  // Drive the gradient bar's ratio off realtime progress events. Falls back to
  // the last completed run so the bar stays informative between syncs.
  const liveChunkRatio = useMemo<number | null>(() => {
    const events =
      activeIngestRun?.progress ?? lastReadyIngestRun?.progress ?? null;
    if (!events) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const r = events[i]?.extra?.["chunks_selected_ratio"];
      if (typeof r === "number") return r;
    }
    return null;
  }, [activeIngestRun, lastReadyIngestRun]);

  // While a run is active, push the latest phase percent into the bar so it
  // animates 0→100 instead of waiting for embed coverage at the end.
  const livePhasePercent = useMemo<number | null>(() => {
    if (!activeIngestRun) return null;
    const events = activeIngestRun.progress ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i]?.percent;
      if (typeof p === "number") return Math.max(0, Math.min(100, p));
    }
    return null;
  }, [activeIngestRun]);
  const liveLatestEvent = useMemo<IngestProgressEvent | null>(() => {
    const events = activeIngestRun?.progress ?? null;
    return events && events.length > 0 ? events[events.length - 1] : null;
  }, [activeIngestRun]);

  // Mirror run lifecycle into the banner state so the user sees the same
  // success/error shape regardless of whether they triggered the run from
  // this tab or from /connect/return.
  useEffect(() => {
    if (activeIngestRun) {
      setIngestResult((prev) => (prev.kind === "running" ? prev : { kind: "running" }));
      return;
    }
    if (!lastReadyIngestRun) return;
    setIngestResult((prev) => {
      if (prev.kind === "ok" && prev.at >= +new Date(lastReadyIngestRun.finished_at ?? 0)) return prev;
      const events = lastReadyIngestRun.progress ?? [];
      const final = [...events].reverse().find((e) => e.phase === "finalize" && e.kind === "end");
      const extra = (final?.extra ?? {}) as Record<string, unknown>;
      const counts = (extra["counts"] ?? {}) as { inserted?: number; updated?: number; errors?: number };
      const bySource = (extra["by_source"] ?? {}) as Record<string, number>;
      const metrics = (extra["metrics"] ?? undefined) as IngestMetrics | undefined;
      return {
        kind: "ok",
        upserted: (counts.inserted ?? 0) + (counts.updated ?? 0),
        inserted: counts.inserted ?? 0,
        updated: counts.updated ?? 0,
        sources: bySource,
        sourceErrors: {},
        writeErrors: counts.errors ?? 0,
        metrics,
        at: +new Date(lastReadyIngestRun.finished_at ?? Date.now()),
      };
    });
  }, [activeIngestRun, lastReadyIngestRun]);

  // Track in-flight ingest so the popup-watcher and the "just_connected"
  // bootstrap path never double-fire.
  const ingestInFlight = useRef(false);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [revoking, setRevoking] = useState<ConnectorId | null>(null);

  async function refreshIngest() {
    if (ingestInFlight.current) return;
    ingestInFlight.current = true;
    setIngestResult({ kind: "running" });
    try {
      const r = await fetch(`${FASTAPI_URL}/ingest/hyperspell`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId }),
      });
      if (r.status === 409) {
        // Another ingest is already running — that's fine, realtime will pick it up.
        setIngestResult({ kind: "running" });
        return;
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        setIngestResult({
          kind: "error",
          status: r.status,
          message: extractErrorMessage(text) || r.statusText || "Unknown error",
          at: Date.now(),
        });
        return;
      }
      // Async backend: response is { runId, status, started_at }. Final metrics
      // arrive on generation_runs.progress via realtime; the live progress card
      // reads them from there.
      setIngestResult({ kind: "running" });
    } catch (e) {
      setIngestResult({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
        at: Date.now(),
      });
    } finally {
      ingestInFlight.current = false;
    }
  }

  async function deleteDocument(doc: ProjectContext) {
    if (deletingIds[doc.id]) return;
    if (!window.confirm(`Delete "${doc.title ?? "(untitled)"}"? Re-syncing will pull it back from ${doc.source}.`)) {
      return;
    }
    setDeletingIds((m) => ({ ...m, [doc.id]: true }));
    // Optimistic remove; realtime DELETE will reconcile.
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    if (selectedDocId === doc.id) setSelectedDocId(null);
    try {
      const r = await fetch(`${FASTAPI_URL}/ingest/document/${doc.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        // Roll back optimistic remove on failure.
        setDocs((prev) => (prev.some((d) => d.id === doc.id) ? prev : [doc, ...prev]));
        alert(`Delete failed: ${extractErrorMessage(text) || r.statusText}`);
      }
    } catch (e) {
      setDocs((prev) => (prev.some((d) => d.id === doc.id) ? prev : [doc, ...prev]));
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingIds((m) => {
        const n = { ...m };
        delete n[doc.id];
        return n;
      });
    }
  }

  async function disconnectSource(source: ConnectorId) {
    if (revoking) return;
    if (!window.confirm(`Disconnect ${source}? You'll need to OAuth again to re-pull.`)) return;
    setRevoking(source);
    try {
      const r = await fetch(`${FASTAPI_URL}/connect/revoke`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId, source }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        alert(`Disconnect failed: ${extractErrorMessage(text) || r.statusText}`);
        return;
      }
      // Re-fetch status (cache-busted on the backend by /connect/revoke).
      const s = await fetch(`${FASTAPI_URL}/connect/status?projectId=${projectId}`);
      if (s.ok) setStatuses(await s.json());
    } catch (e) {
      alert(`Disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRevoking(null);
    }
  }

  // FastAPI errors come back as `{"detail": "..."}` (or `{"detail": [...]}` for
  // pydantic validation). Pull the human string out so the banner doesn't show
  // raw JSON to the user.
  function extractErrorMessage(text: string): string {
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        const detail = (parsed as { detail?: unknown }).detail;
        if (typeof detail === "string") return detail;
        if (Array.isArray(detail)) {
          return detail
            .map((d) =>
              typeof d === "string"
                ? d
                : (d as { msg?: string })?.msg ?? JSON.stringify(d),
            )
            .join("; ");
        }
        if (detail && typeof detail === "object") {
          return (detail as { message?: string }).message ?? JSON.stringify(detail);
        }
      }
    } catch {
      /* not JSON */
    }
    return text.slice(0, 240);
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
    <div className="space-y-3">
      <IngestBanner result={ingestResult} onDismiss={() => setIngestResult({ kind: "idle" })} />
    <div className="grid grid-cols-12 gap-4 min-h-[calc(100vh-320px)]">
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
          const status = statuses?.[selectedSource] ?? "not_connected";
          const isConnected = status === "connected";

          if (disabled) {
            return (
              <button
                disabled
                title={tooltip}
                className="mt-3 w-full rounded-lg border border-dashed border-ink-200 px-3 py-2 text-sm text-ink-400 cursor-not-allowed opacity-60"
              >
                {c?.label} — {("unsupported" in (c ?? {})) ? "not supported by Hyperspell" : "beta (used in plan generation)"}
              </button>
            );
          }
          if (isConnected) {
            const isRevoking = revoking === selectedSource;
            const isSyncing = ingestResult.kind === "running";
            return (
              <div className="mt-3 space-y-1.5">
                <button
                  onClick={refreshIngest}
                  disabled={isSyncing}
                  className="w-full rounded-lg bg-ink-900 text-white px-3 py-2 text-sm hover:opacity-90 disabled:opacity-50"
                >
                  {isSyncing ? "Syncing…" : `🔄 Sync ${c?.label}`}
                </button>
                <button
                  onClick={() => disconnectSource(selectedSource)}
                  disabled={isRevoking}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-xs text-ink-600 hover:text-rose-700 hover:border-rose-300 disabled:opacity-50"
                >
                  {isRevoking ? "Disconnecting…" : `Disconnect ${c?.label}`}
                </button>
              </div>
            );
          }
          return (
            <button
              onClick={() => startConnect(selectedSource)}
              className="mt-3 w-full rounded-lg border border-dashed border-ink-200 px-3 py-2 text-sm text-ink-400 hover:text-ink-900 hover:border-ink-400 transition"
            >
              + Connect {c?.label}
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
            const isDeleting = !!deletingIds[d.id];
            return (
              <li key={d.id}>
                <div
                  className={
                    "group relative rounded-lg border p-3 transition " +
                    (active ? "border-ink-900 bg-ink-50" : "border-ink-200 hover:border-ink-400")
                  }
                >
                  <button
                    onClick={() => setSelectedDocId(d.id)}
                    className="w-full text-left pr-7"
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteDocument(d);
                    }}
                    disabled={isDeleting}
                    title="Delete this document"
                    className="absolute top-2 right-2 h-6 w-6 inline-flex items-center justify-center rounded-md text-ink-400 opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-700 transition disabled:opacity-50"
                    aria-label="Delete document"
                  >
                    {isDeleting ? "…" : "×"}
                  </button>
                </div>
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
            <ChunkingBar
              activeRun={activeIngestRun}
              latestEvent={liveLatestEvent}
              livePhasePercent={livePhasePercent}
              chunkRatio={liveChunkRatio}
              previewChunks={chunkPreview.length}
            />
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
            {chunkPreview.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-ink-400">Chunk Stream</div>
                <div className="space-y-2">
                  {chunkPreview.map((chunk, idx) => (
                    <div
                      key={`${selectedDoc.id}-chunk-${idx}`}
                      className="group rounded-lg border border-ink-200 bg-white/80 p-2 shadow-[0_1px_6px_rgba(99,102,241,0.08)] transition hover:-translate-y-[1px] hover:border-indigo-300 hover:shadow-[0_4px_18px_rgba(79,70,229,0.18)]"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                          Chunk {idx + 1}
                        </span>
                        <span className="text-[10px] text-ink-400">{chunk.chars} chars</span>
                      </div>
                      <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400 transition-all duration-700"
                          style={{ width: `${Math.max(8, Math.min(100, Math.round((chunk.chars / 420) * 100)))}%` }}
                        />
                      </div>
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-ink-600">
                        {chunk.text}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
    </div>
  );
}

function IngestBanner({ result, onDismiss }: { result: IngestResult; onDismiss: () => void }) {
  if (result.kind === "idle") return null;
  if (result.kind === "running") {
    return (
      <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-1.5 text-xs text-ink-600">
        Pulling from Hyperspell…
      </div>
    );
  }
  if (result.kind === "error") {
    const headline = (() => {
      if (result.status === 401) return "Backend rejected demo token";
      if (result.status === 404) return "Project not found";
      if (result.status && result.status >= 500) return "Backend error";
      if (result.status) return `Ingest failed (${result.status})`;
      return "Couldn't reach backend";
    })();
    const hint = (() => {
      if (result.status === 401)
        return `Set NEXT_PUBLIC_DEMO_TOKEN to match the backend's DEMO_TOKEN, then reload.`;
      if (result.status === 404) return null;
      if (result.status && result.status >= 500) return null;
      if (!result.status) return `Is the backend up at ${getFastApiOrigin()}?`;
      return null;
    })();
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="font-medium">{headline}.</span>{" "}
          <span className="opacity-80 break-words">{result.message}</span>
          {hint && <span className="opacity-60"> · {hint}</span>}
        </div>
        <button onClick={onDismiss} className="text-rose-700 hover:opacity-70 shrink-0" aria-label="Dismiss">×</button>
      </div>
    );
  }
  // ok
  const sourceErrors = Object.entries(result.sourceErrors);
  const sourceCounts = Object.entries(result.sources);
  const hasIssues = sourceErrors.length > 0 || result.writeErrors > 0;
  const tone = hasIssues
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return (
    <div className={`rounded-md border ${tone} px-3 py-1.5 text-xs flex items-start justify-between gap-3`}>
      <div className="min-w-0">
        <span className="font-medium">
          Synced {result.upserted} item{result.upserted === 1 ? "" : "s"}
          {result.upserted > 0 && ` (${result.inserted} new, ${result.updated} updated)`}.
        </span>
        {sourceCounts.length > 0 && (
          <span className="opacity-80"> · {sourceCounts.map(([s, n]) => `${s} ${n}`).join(", ")}</span>
        )}
        {sourceErrors.length > 0 && (
          <span className="opacity-80">
            {" · "}
            issues: {sourceErrors.map(([s, msg]) => `${s} (${msg.split(":")[0]})`).join(", ")}
          </span>
        )}
        {result.writeErrors > 0 && <span className="opacity-80"> · {result.writeErrors} write error{result.writeErrors === 1 ? "" : "s"}</span>}
      </div>
      <button onClick={onDismiss} className="hover:opacity-70 shrink-0" aria-label="Dismiss">×</button>
    </div>
  );
}

function getFastApiOrigin(): string {
  try {
    return new URL(FASTAPI_URL).origin;
  } catch {
    return FASTAPI_URL;
  }
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

function ChunkingBar({
  activeRun,
  latestEvent,
  livePhasePercent,
  chunkRatio,
  previewChunks,
}: {
  activeRun: IngestRun | null;
  latestEvent: IngestProgressEvent | null;
  livePhasePercent: number | null;
  chunkRatio: number | null;
  previewChunks: number;
}) {
  const isLive = !!activeRun;
  // While a run is active, fill from phase percent. After it ends, settle on
  // embed coverage ratio. If there's no run history at all, render a quiet
  // 0% bar with no fake number.
  const fillRatio = isLive
    ? livePhasePercent !== null
      ? livePhasePercent / 100
      : 0
    : chunkRatio;
  const widthPct = fillRatio === null ? 0 : Math.round(fillRatio * 100);

  const phaseLabel = (() => {
    if (!isLive) return null;
    const phase = latestEvent?.phase ?? "load";
    return INGEST_PHASE_LABEL[phase] ?? phase;
  })();

  return (
    <section className="relative overflow-hidden rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-violet-50 to-cyan-50 p-3 shadow-sm">
      <div className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-indigo-300/40 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-10 -left-8 h-24 w-24 rounded-full bg-cyan-300/40 blur-2xl" />
      <div className="relative z-10">
        <div className="mb-2 flex items-center justify-end gap-2">
          {isLive && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 shadow-sm">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              live
            </span>
          )}
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] text-indigo-700 shadow-sm">
            {previewChunks} preview chunks
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/80">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-500 to-indigo-500 transition-all duration-700"
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <div className="mt-1 text-[11px] text-indigo-700/90 truncate">
          {isLive ? (
            <>
              {phaseLabel}
              {latestEvent?.message && (
                <span className="text-indigo-700/70"> · {latestEvent.message}</span>
              )}
              <span className="ml-1 tabular-nums">{widthPct}%</span>
            </>
          ) : chunkRatio === null ? (
            <span className="text-indigo-700/60">Sync to compute embed coverage.</span>
          ) : (
            <>Embed coverage {widthPct}%</>
          )}
        </div>
      </div>
    </section>
  );
}

function mergeIngestRow(
  prev: IngestRun[],
  payload: { eventType: string; new?: unknown; old?: unknown },
): IngestRun[] {
  if (payload.eventType === "INSERT") {
    const row = payload.new as IngestRun;
    if (!row || prev.some((p) => p.id === row.id)) return prev;
    return [row, ...prev];
  }
  if (payload.eventType === "UPDATE") {
    const row = payload.new as IngestRun;
    if (!row) return prev;
    return prev.map((p) => (p.id === row.id ? row : p));
  }
  if (payload.eventType === "DELETE") {
    const row = payload.old as IngestRun;
    if (!row) return prev;
    return prev.filter((p) => p.id !== row.id);
  }
  return prev;
}

function buildChunkPreview(text: string | null): Array<{ text: string; chars: number }> {
  if (!text?.trim()) return [];
  const raw = text.trim();
  const blocks = raw
    .split(/\n\s*\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seeds = blocks.length > 0 ? blocks : [raw.replace(/\s+/g, " ")];
  return seeds.slice(0, 6).map((block) => ({
    text: block.length > 240 ? `${block.slice(0, 240)}...` : block,
    chars: block.length,
  }));
}

