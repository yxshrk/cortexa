"use client";

import { useEffect, useMemo, useState } from "react";
import { FASTAPI_URL, authHeaders, supabase } from "@/lib/supabase";

type KnowledgeDocument = {
  id: string;
  project_id: string;
  week_start: string;
  week_end: string;
  status: "generating" | "ready" | "error";
  summary: string | null;
  themes: string[] | null;
  decisions: string[] | null;
  blockers: string[] | null;
  open_questions: string[] | null;
  generated_at: string;
};

type PlanItem = {
  id: string;
  knowledge_document_id: string;
  project_id: string;
  generation_run_id: string | null;
  category: "bug_fix" | "new_feature" | "maintenance";
  title: string;
  description: string | null;
  source_refs: unknown[] | null;
  code_refs: { path?: string; lines?: string; snippet?: string; ref_url?: string }[] | null;
  next_step: string | null;
  confidence: number | null;
  generated_at: string;
};

type ProgressEvent = {
  ts?: string;
  phase?: string;
  kind?: "start" | "progress" | "end" | "info" | "reasoning" | "error";
  message?: string;
  percent?: number | null;
  extra?: Record<string, unknown>;
};

type GenerationRun = {
  id: string;
  project_id: string;
  week_start: string;
  status: "queued" | "running" | "ready" | "error";
  error: string | null;
  progress: ProgressEvent[] | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

const CATEGORY_META: Record<
  PlanItem["category"],
  { label: string; emoji: string; tone: string; hint: string }
> = {
  bug_fix: {
    label: "bug_fix",
    emoji: "🐛",
    tone: "border-rose-200 bg-rose-50 text-rose-900",
    hint: "From blockers + error chunks",
  },
  new_feature: {
    label: "new_feature",
    emoji: "✨",
    tone: "border-violet-200 bg-violet-50 text-violet-900",
    hint: "From decisions + meeting asks",
  },
  maintenance: {
    label: "maintenance",
    emoji: "🔧",
    tone: "border-amber-200 bg-amber-50 text-amber-900",
    hint: "From open_questions + tech debt",
  },
};

const PHASE_LABEL: Record<string, string> = {
  load: "📥 Loading inputs",
  synthesize: "🧠 Synthesizing",
  categorize: "🗂️ Categorizing",
  draft_actions: "⚡ Drafting actions",
  finalize: "✅ Finalizing",
};

export default function KnowledgeDocTab({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [runs, setRuns] = useState<GenerationRun[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Initial load + realtime subscriptions
  useEffect(() => {
    let alive = true;
    void Promise.all([
      supabase
        .from("knowledge_documents")
        .select("*")
        .eq("project_id", projectId)
        .order("week_start", { ascending: false }),
      supabase
        .from("plan_items")
        .select("*")
        .eq("project_id", projectId)
        .order("generated_at", { ascending: false }),
      supabase
        .from("generation_runs")
        .select("*")
        .eq("project_id", projectId)
        .eq("kind", "plan")
        .order("created_at", { ascending: false })
        .limit(20),
    ]).then(([d, i, r]) => {
      if (!alive) return;
      const docList = (d.data ?? []) as KnowledgeDocument[];
      setDocs(docList);
      setItems((i.data ?? []) as PlanItem[]);
      setRuns((r.data ?? []) as GenerationRun[]);
      setSelectedDocId((prev) => prev ?? docList[0]?.id ?? null);
    });

    const channel = supabase
      .channel(`kdoc:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "knowledge_documents", filter: `project_id=eq.${projectId}` },
        (p) => {
          setDocs((prev) => mergeRow(prev, p));
          setSelectedDocId((prev) => {
            if (prev) return prev;
            if (p.eventType === "INSERT") return (p.new as KnowledgeDocument).id;
            return prev;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "plan_items", filter: `project_id=eq.${projectId}` },
        (p) => setItems((prev) => mergeRow(prev, p)),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generation_runs", filter: `project_id=eq.${projectId}` },
        (p) => {
          // Realtime can't filter by `kind`; do it client-side so ingest runs
          // never end up in the plan-generation progress card.
          const row = (p.new ?? p.old) as { kind?: string } | undefined;
          if (row && row.kind && row.kind !== "plan") return;
          setRuns((prev) => mergeRow(prev, p));
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedDocId) ?? docs[0] ?? null,
    [docs, selectedDocId],
  );
  const itemsForDoc = useMemo(
    () => (selectedDoc ? items.filter((it) => it.knowledge_document_id === selectedDoc.id) : []),
    [items, selectedDoc],
  );
  const grouped = useMemo(() => groupByCategory(itemsForDoc), [itemsForDoc]);
  const itemCountByDoc = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) m[it.knowledge_document_id] = (m[it.knowledge_document_id] ?? 0) + 1;
    return m;
  }, [items]);

  const activeRun = runs.find((r) => r.status === "running" || r.status === "queued") ?? null;
  const lastErrorRun = runs.find((r) => r.status === "error") ?? null;

  async function generate() {
    setBusy(true);
    setGenerateError(null);
    try {
      const r = await fetch(`${FASTAPI_URL}/plan/generate`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId }),
      });
      if (r.status === 409) {
        setGenerateError("A plan generation is already in flight for this week.");
        return;
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        setGenerateError(`Generate failed (${r.status}): ${extractDetail(text)}`);
        return;
      }
      // /plan/generate now returns immediately; realtime delivers progress events.
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Source/flow chip bar */}
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

      {/* Generate header */}
      <div className="rounded-xl border border-ink-200 bg-white p-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">
            Synthesis run
          </div>
          <h2 className="text-[17px] font-semibold tracking-[-0.2px] text-ink-900 mt-0.5">
            {selectedDoc
              ? `Week of ${formatYmdLocal(selectedDoc.week_start)}`
              : `Week of ${new Date().toLocaleDateString()}`}
          </h2>
          <p className="text-[12px] text-ink-500 mt-1 leading-relaxed">
            Pulls every <code>project_context</code> + <code>meeting_notes</code> row, runs synthesis +
            categorization, writes <code>knowledge_documents</code> and <code>plan_items</code>.
          </p>
        </div>
        <button
          onClick={generate}
          disabled={busy || !!activeRun}
          className="rounded-lg bg-ink-900 text-white px-4 py-2 text-[13px] font-medium hover:opacity-90 transition-opacity duration-150 disabled:opacity-50 shrink-0"
        >
          {busy || activeRun ? "Generating…" : selectedDoc ? "✨ Regenerate" : "✨ Generate"}
        </button>
      </div>

      {generateError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {generateError}
        </div>
      )}
      {!generateError && lastErrorRun && !activeRun && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Last run failed: {lastErrorRun.error || "unknown error"}
        </div>
      )}

      {activeRun && <ProgressCard run={activeRun} />}

      {/* Two-pane: list left, doc right */}
      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-4 lg:col-span-3 rounded-xl border border-ink-200 bg-white p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-400 mb-3 px-1">
            Knowledge documents <span className="text-ink-300 font-normal tracking-normal normal-case">· {docs.length}</span>
          </h3>
          {docs.length === 0 ? (
            <div className="text-[12px] text-ink-400 italic px-1 py-3">
              None yet. Click Generate to create the first one.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {docs.map((d) => {
                const active = (selectedDoc?.id ?? null) === d.id;
                const count = itemCountByDoc[d.id] ?? 0;
                return (
                  <li key={d.id}>
                    <button
                      onClick={() => setSelectedDocId(d.id)}
                      className={
                        "w-full text-left rounded-lg px-3 py-2 transition-colors duration-150 flex flex-col gap-0.5 " +
                        (active ? "bg-ink-900 text-white" : "hover:bg-ink-100 text-ink-900")
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium truncate">
                          {formatYmdLocal(d.week_start)}
                        </span>
                        <DocStatusDot status={d.status} dark={active} />
                      </div>
                      <div
                        className={
                          "text-[11px] " + (active ? "text-white/60" : "text-ink-400")
                        }
                      >
                        {count} item{count === 1 ? "" : "s"}
                        {d.themes && d.themes.length > 0 &&
                          ` · ${d.themes.length} theme${d.themes.length === 1 ? "" : "s"}`}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="col-span-8 lg:col-span-9 space-y-4">
          {!selectedDoc ? (
            <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
              <div className="text-lg mb-1">🧠 Nothing here yet</div>
              <div className="text-sm">
                Click <strong>Generate</strong> to synthesize this week&apos;s meeting notes and project
                context into a knowledge document with categorized plan items.
              </div>
            </div>
          ) : (
            <>
              <DocCard doc={selectedDoc} />
              <PlanItemsPanel items={itemsForDoc} grouped={grouped} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Progress card (live during a running generation_run) ─────────────────────
function ProgressCard({ run }: { run: GenerationRun }) {
  const events = run.progress ?? [];
  const lastWithPercent = [...events].reverse().find((e) => typeof e.percent === "number");
  const percent = Math.max(0, Math.min(100, Math.round(lastWithPercent?.percent ?? 5)));
  const lastEvent = events[events.length - 1];
  const phase = lastEvent?.phase ?? "load";
  const tail = events.slice(-6);

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live · run {run.id.slice(0, 8)}
          </div>
          <div className="text-base font-semibold text-ink-900 mt-0.5 truncate">
            {PHASE_LABEL[phase] ?? phase}
            {lastEvent?.message && (
              <span className="text-ink-400 font-normal text-sm">  · {lastEvent.message}</span>
            )}
          </div>
        </div>
        <div className="text-2xl font-bold tabular-nums text-ink-900">{percent}%</div>
      </div>

      <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
        <div
          className="h-full bg-ink-900 transition-all duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {tail.length > 0 && (
        <ol className="space-y-1.5 pt-1">
          {tail.map((e, i) => (
            <TraceEvent key={i} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TraceEvent({ event }: { event: ProgressEvent }) {
  const isReasoning = event.kind === "reasoning";
  const isError = event.kind === "error";
  const isEnd = event.kind === "end";

  const dot = isError
    ? "bg-rose-500"
    : isReasoning
      ? "bg-ink-900"
      : isEnd
        ? "bg-emerald-500"
        : "bg-ink-400";

  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`mt-1.5 inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
      <div className="min-w-0 flex-1">
        <span
          className={
            isReasoning
              ? "text-ink-600 italic"
              : isError
                ? "text-rose-700"
                : "text-ink-600"
          }
        >
          {event.message}
        </span>
        {event.ts && (
          <span className="text-ink-400 ml-1.5 tabular-nums">
            {new Date(event.ts).toLocaleTimeString(undefined, { hour12: false })}
          </span>
        )}
      </div>
    </li>
  );
}

// ─── doc + plan items ─────────────────────────────────────────────────────────
function DocCard({ doc }: { doc: KnowledgeDocument }) {
  return (
    <article className="rounded-xl border border-ink-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-400">
          Synthesis cards
        </h3>
        <DocStatusPill status={doc.status} />
      </div>
      <p className="text-[13px] text-ink-900 leading-relaxed">
        {doc.summary || <span className="text-ink-400 italic">(empty summary)</span>}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <BulletBlock title="Themes" items={doc.themes} />
        <BulletBlock title="Decisions" items={doc.decisions} />
        <BulletBlock title="Blockers" items={doc.blockers} />
        <BulletBlock title="Open questions" items={doc.open_questions} />
      </div>
    </article>
  );
}

function PlanItemsPanel({
  items,
  grouped,
}: {
  items: PlanItem[];
  grouped: Record<string, PlanItem[]>;
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-400 mb-3">
        Actionable insights{" "}
        {items.length > 0 && <span className="text-ink-300 font-normal tracking-normal normal-case">· {items.length}</span>}
      </h3>
      {items.length === 0 ? (
        <ul className="space-y-2 text-sm">
          {(Object.keys(CATEGORY_META) as PlanItem["category"][]).map((cat) => {
            const meta = CATEGORY_META[cat];
            return (
              <li
                key={cat}
                className="flex items-start gap-3 rounded-lg border border-dashed border-ink-200 p-3"
              >
                <span className="text-base">{meta.emoji}</span>
                <div>
                  <code className="text-ink-900 text-xs font-semibold">{meta.label}</code>
                  <div className="text-xs text-ink-400 mt-0.5">{meta.hint}</div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([cat, list]) => (
            <CategorySection key={cat} category={cat as PlanItem["category"]} items={list} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  items,
}: {
  category: PlanItem["category"];
  items: PlanItem[];
}) {
  const meta = CATEGORY_META[category];
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400 mb-2 flex items-center gap-1.5">
        <span>{meta.emoji}</span>
        <code>{meta.label}</code>
        <span className="text-ink-300 font-normal normal-case tracking-normal">· {items.length}</span>
      </div>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className={`rounded-lg border ${meta.tone} p-3 space-y-1.5`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-medium text-ink-900">{it.title}</div>
              {it.confidence !== null && (
                <span className="text-[10px] text-ink-400 shrink-0 tabular-nums">
                  {Math.round((it.confidence ?? 0) * 100)}%
                </span>
              )}
            </div>
            {it.description && <p className="text-[12px] text-ink-600 leading-snug">{it.description}</p>}
            {it.next_step && (
              <div className="text-[11px] text-ink-600">
                <span className="font-semibold">Next:</span> {it.next_step}
              </div>
            )}
            {it.code_refs && it.code_refs.length > 0 && (
              <details className="text-[11px] text-ink-400">
                <summary className="cursor-pointer hover:text-ink-600">
                  {it.code_refs.length} code ref{it.code_refs.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 space-y-0.5 pl-3 font-mono">
                  {it.code_refs.map((ref, i) => (
                    <li key={i} className="break-all">
                      {ref.path}
                      {ref.lines && <span className="opacity-70">:{ref.lines}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BulletBlock({ title, items }: { title: string; items: string[] | null }) {
  const list = items ?? [];
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400 mb-1.5">
        {title} {list.length > 0 && <span className="text-ink-300 font-normal tracking-normal normal-case">· {list.length}</span>}
      </div>
      {list.length === 0 ? (
        <div className="text-[12px] text-ink-400 italic">none</div>
      ) : (
        <ul className="text-[13px] text-ink-900 list-disc pl-4 space-y-0.5">
          {list.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── tiny components ─────────────────────────────────────────────────────────
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

function DocStatusPill({ status }: { status: KnowledgeDocument["status"] }) {
  const cfg = {
    generating: { label: "generating", cls: "bg-ink-100 text-ink-600" },
    ready: { label: "ready", cls: "bg-emerald-100 text-emerald-700" },
    error: { label: "error", cls: "bg-rose-100 text-rose-700" },
  }[status];
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

function DocStatusDot({
  status,
  dark,
}: {
  status: KnowledgeDocument["status"];
  dark?: boolean;
}) {
  const cls = {
    generating: dark ? "bg-white/40" : "bg-ink-400",
    ready: "bg-emerald-500",
    error: "bg-rose-500",
  }[status];
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function groupByCategory(items: PlanItem[]): Record<string, PlanItem[]> {
  const out: Record<string, PlanItem[]> = { bug_fix: [], new_feature: [], maintenance: [] };
  for (const it of items) {
    if (out[it.category]) out[it.category].push(it);
  }
  for (const k of Object.keys(out)) {
    if (out[k].length === 0) delete out[k];
  }
  return out;
}

function mergeRow<T extends { id: string }>(
  prev: T[],
  payload: { eventType: string; new?: unknown; old?: unknown },
): T[] {
  if (payload.eventType === "INSERT") {
    const row = payload.new as T;
    if (!row || prev.some((p) => p.id === row.id)) return prev;
    return [row, ...prev];
  }
  if (payload.eventType === "UPDATE") {
    const row = payload.new as T;
    if (!row) return prev;
    return prev.map((p) => (p.id === row.id ? row : p));
  }
  if (payload.eventType === "DELETE") {
    const row = payload.old as T;
    if (!row) return prev;
    return prev.filter((p) => p.id !== row.id);
  }
  return prev;
}

function formatYmdLocal(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d)).toLocaleDateString();
}

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
