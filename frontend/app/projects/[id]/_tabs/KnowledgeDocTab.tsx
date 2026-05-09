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

type GenerationRun = {
  id: string;
  project_id: string;
  week_start: string;
  status: "queued" | "running" | "ready" | "error";
  error: string | null;
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

export default function KnowledgeDocTab({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [runs, setRuns] = useState<GenerationRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Initial load + realtime on knowledge_documents, plan_items, generation_runs.
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
        .order("created_at", { ascending: false })
        .limit(10),
    ]).then(([d, i, r]) => {
      if (!alive) return;
      setDocs((d.data ?? []) as KnowledgeDocument[]);
      setItems((i.data ?? []) as PlanItem[]);
      setRuns((r.data ?? []) as GenerationRun[]);
    });

    const channel = supabase
      .channel(`kdoc:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "knowledge_documents", filter: `project_id=eq.${projectId}` },
        (p) => setDocs((prev) => mergeRow(prev, p)),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "plan_items", filter: `project_id=eq.${projectId}` },
        (p) => setItems((prev) => mergeRow(prev, p)),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generation_runs", filter: `project_id=eq.${projectId}` },
        (p) => setRuns((prev) => mergeRow(prev, p)),
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const latestDoc = docs[0] ?? null;
  const itemsForDoc = useMemo(
    () => (latestDoc ? items.filter((it) => it.knowledge_document_id === latestDoc.id) : []),
    [items, latestDoc],
  );
  const grouped = useMemo(() => groupByCategory(itemsForDoc), [itemsForDoc]);
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
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Render YYYY-MM-DD as a local-date instead of letting Date() parse it as UTC
  // midnight (which then shifts back a day in negative offsets like PST/PDT).
  const headerLabel = latestDoc
    ? `Week of ${formatYmdLocal(latestDoc.week_start)}`
    : `Week of ${new Date().toLocaleDateString()}`;

  return (
    <div className="space-y-5">
      {/* Source/flow banner */}
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
          <h2 className="text-lg font-semibold text-ink-900 mt-0.5">{headerLabel}</h2>
          <p className="text-xs text-ink-400 mt-1">
            Pulls every <code>project_context</code> + <code>meeting_notes</code> row, runs synthesis +
            categorization, writes <code>knowledge_documents</code> and <code>plan_items</code>.
          </p>
          {activeRun && (
            <div className="text-xs text-emerald-700 mt-2 flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Generating… (run {activeRun.id.slice(0, 8)})
            </div>
          )}
        </div>
        <button
          onClick={generate}
          disabled={busy || !!activeRun}
          className="rounded-lg bg-ink-900 text-white px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy || activeRun ? "Generating…" : latestDoc ? "✨ Regenerate" : "✨ Generate"}
        </button>
      </div>

      {generateError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {generateError}
        </div>
      )}
      {!generateError && lastErrorRun && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Last run failed: {lastErrorRun.error || "unknown error"}
        </div>
      )}

      {/* Output area */}
      <div className="grid grid-cols-12 gap-4">
        <section className="col-span-7 rounded-xl border border-ink-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3 flex items-center gap-2">
            Synthesis cards
            {latestDoc && <StatusPill status={latestDoc.status} />}
          </h3>
          {latestDoc ? (
            <DocBody doc={latestDoc} />
          ) : (
            <EmptyHint
              text={
                <>
                  Summary · themes · decisions · blockers · open_questions appear here as the
                  synthesizer streams into <code>knowledge_documents</code>.
                </>
              }
            />
          )}
        </section>
        <section className="col-span-5 rounded-xl border border-ink-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase text-ink-400 tracking-wide mb-3">
            Plan items {itemsForDoc.length > 0 && <span className="text-ink-400/70">· {itemsForDoc.length}</span>}
          </h3>
          {itemsForDoc.length === 0 ? (
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
        </section>
      </div>
    </div>
  );
}

// ─── building blocks ──────────────────────────────────────────────────────────
function DocBody({ doc }: { doc: KnowledgeDocument }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-900 leading-relaxed">
        {doc.summary || <span className="text-ink-400 italic">(empty summary)</span>}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <BulletBlock title="Themes" items={doc.themes} />
        <BulletBlock title="Decisions" items={doc.decisions} />
        <BulletBlock title="Blockers" items={doc.blockers} />
        <BulletBlock title="Open questions" items={doc.open_questions} />
      </div>
    </div>
  );
}

function BulletBlock({ title, items }: { title: string; items: string[] | null }) {
  const list = items ?? [];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold mb-1">
        {title} {list.length > 0 && <span className="text-ink-400/70">· {list.length}</span>}
      </div>
      {list.length === 0 ? (
        <div className="text-xs text-ink-400 italic">none</div>
      ) : (
        <ul className="text-sm text-ink-900 list-disc pl-4 space-y-0.5">
          {list.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
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
      <div className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold mb-1.5 flex items-center gap-1">
        <span>{meta.emoji}</span>
        <code>{meta.label}</code>
        <span className="text-ink-400/70 font-normal normal-case">· {items.length}</span>
      </div>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className={`rounded-lg border ${meta.tone} p-2.5 space-y-1`}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-ink-900 text-sm">{it.title}</div>
              {it.confidence !== null && (
                <span className="text-[10px] text-ink-400 shrink-0">
                  {Math.round((it.confidence ?? 0) * 100)}%
                </span>
              )}
            </div>
            {it.description && (
              <p className="text-xs text-ink-600 leading-snug">{it.description}</p>
            )}
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

function StatusPill({ status }: { status: KnowledgeDocument["status"] }) {
  const cfg = {
    generating: { label: "generating", cls: "bg-ink-100 text-ink-600" },
    ready: { label: "ready", cls: "bg-emerald-100 text-emerald-700" },
    error: { label: "error", cls: "bg-rose-100 text-rose-700" },
  }[status];
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function EmptyHint({ text }: { text: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-ink-400 text-sm">
      {text}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────
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
