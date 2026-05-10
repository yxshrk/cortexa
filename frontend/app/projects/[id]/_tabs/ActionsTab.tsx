"use client";

import { useEffect, useMemo, useState } from "react";
import { FASTAPI_URL, authHeaders, supabase } from "@/lib/supabase";

type ActionType = "linear_ticket" | "github_pr" | "devin_handoff";
type ActionStatus = "draft" | "executing" | "executed" | "failed";

type GeneratedAction = {
  id: string;
  plan_item_id: string;
  project_id: string;
  generation_run_id: string | null;
  action_type: ActionType;
  payload: Record<string, unknown> | null;
  status: ActionStatus;
  external_url: string | null;
  created_at: string;
};

type PlanItemRef = {
  id: string;
  title: string;
  category: "bug_fix" | "new_feature" | "maintenance";
};

const ACTION_META: Record<ActionType, { label: string; emoji: string; tone: string }> = {
  linear_ticket: { label: "Linear ticket", emoji: "📋", tone: "border-violet-200" },
  github_pr: { label: "GitHub PR", emoji: "🐙", tone: "border-slate-200" },
  devin_handoff: { label: "Devin handoff", emoji: "🤖", tone: "border-cyan-200" },
};

const CATEGORY_EMOJI: Record<PlanItemRef["category"], string> = {
  bug_fix: "🐛",
  new_feature: "✨",
  maintenance: "🔧",
};

export default function ActionsTab({ projectId }: { projectId: string }) {
  const [actions, setActions] = useState<GeneratedAction[]>([]);
  const [planItems, setPlanItems] = useState<PlanItemRef[]>([]);
  const [filter, setFilter] = useState<"all" | ActionType>("all");
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  // Initial load + realtime
  useEffect(() => {
    let alive = true;
    void Promise.all([
      supabase
        .from("generated_actions")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
      supabase
        .from("plan_items")
        .select("id,title,category")
        .eq("project_id", projectId),
    ]).then(([a, p]) => {
      if (!alive) return;
      setActions((a.data ?? []) as GeneratedAction[]);
      setPlanItems((p.data ?? []) as PlanItemRef[]);
    });

    const channel = supabase
      .channel(`actions:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generated_actions", filter: `project_id=eq.${projectId}` },
        (p) => setActions((prev) => mergeRow(prev, p)),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "plan_items", filter: `project_id=eq.${projectId}` },
        (p) => setPlanItems((prev) => mergeRow(prev, p)),
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const planItemsById = useMemo(() => {
    const m = new Map<string, PlanItemRef>();
    for (const pi of planItems) m.set(pi.id, pi);
    return m;
  }, [planItems]);

  const visible = useMemo(
    () => (filter === "all" ? actions : actions.filter((a) => a.action_type === filter)),
    [actions, filter],
  );

  // Group visible actions by plan_item, preserving the (newest-first) order of `actions`.
  const groupedOrder = useMemo(() => {
    const seen: string[] = [];
    const out = new Map<string, GeneratedAction[]>();
    for (const a of visible) {
      if (!out.has(a.plan_item_id)) {
        out.set(a.plan_item_id, []);
        seen.push(a.plan_item_id);
      }
      out.get(a.plan_item_id)!.push(a);
    }
    return seen.map((piId) => [piId, out.get(piId)!] as const);
  }, [visible]);

  const counts = useMemo(() => {
    const c: Record<ActionStatus, number> = { draft: 0, executing: 0, executed: 0, failed: 0 };
    for (const a of actions) c[a.status] += 1;
    return c;
  }, [actions]);

  const targetCounts: Record<ActionType, number> = useMemo(
    () => ({
      linear_ticket: actions.filter((a) => a.action_type === "linear_ticket").length,
      github_pr: actions.filter((a) => a.action_type === "github_pr").length,
      devin_handoff: actions.filter((a) => a.action_type === "devin_handoff").length,
    }),
    [actions],
  );

  async function execute(action: GeneratedAction) {
    if (busyIds[action.id]) return;
    setBusyIds((b) => ({ ...b, [action.id]: true }));
    setErrorById((e) => {
      const next = { ...e };
      delete next[action.id];
      return next;
    });
    try {
      const r = await fetch(`${FASTAPI_URL}/actions/${action.id}/execute`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        setErrorById((e) => ({ ...e, [action.id]: extractDetail(text) || r.statusText }));
        return;
      }
      // Realtime UPDATE flips the row to executed/external_url. Nothing else to do.
    } catch (e) {
      setErrorById((eMap) => ({
        ...eMap,
        [action.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyIds((b) => {
        const n = { ...b };
        delete n[action.id];
        return n;
      });
    }
  }

  return (
    <div className="space-y-5">
      {/* Source/flow chip bar — Actions emphasized */}
      <div className="rounded-xl border border-ink-200 bg-white p-4 flex items-center gap-3 text-sm">
        <SourceChip icon="🔌" label="Connectors" />
        <span className="text-ink-400">+</span>
        <SourceChip icon="🎙️" label="Meeting Notes" />
        <span className="text-ink-400">+</span>
        <SourceChip icon="🐙" label="Codebase refs" />
        <span className="text-ink-400 mx-1">→</span>
        <SourceChip icon="🧠" label="Knowledge Doc" />
        <span className="text-ink-400 mx-1">→</span>
        <SourceChip icon="⚡" label="Actions" emphasis />
      </div>

      <div className="rounded-xl border border-ink-200 bg-white p-5 flex items-center justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">
            Generated from Knowledge Doc
          </div>
          <h2 className="text-lg font-semibold text-ink-900 mt-0.5">
            Action queue{" "}
            <span className="text-ink-400 font-normal text-sm">
              · {actions.length} draft{actions.length === 1 ? "" : "s"}
              {counts.executed > 0 && ` · ${counts.executed} executed`}
              {counts.failed > 0 && ` · ${counts.failed} failed`}
            </span>
          </h2>
          <p className="text-xs text-ink-400 mt-1">
            Each card is a <code>generated_actions</code> row. Execute fans out to Linear (issues),
            GitHub (PRs / comments), or Devin (autonomous code tasks).
          </p>
        </div>
        <FilterPicker value={filter} onChange={setFilter} actions={actions} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TargetTile
          icon="📋"
          label="Linear"
          detail="Create issue · update status"
          count={targetCounts.linear_ticket}
          active={filter === "linear_ticket"}
          onClick={() => setFilter(filter === "linear_ticket" ? "all" : "linear_ticket")}
        />
        <TargetTile
          icon="🐙"
          label="GitHub"
          detail="Open PR · file comment"
          count={targetCounts.github_pr}
          active={filter === "github_pr"}
          onClick={() => setFilter(filter === "github_pr" ? "all" : "github_pr")}
        />
        <TargetTile
          icon="🤖"
          label="Devin"
          detail="Spawn autonomous task"
          count={targetCounts.devin_handoff}
          active={filter === "devin_handoff"}
          onClick={() => setFilter(filter === "devin_handoff" ? "all" : "devin_handoff")}
        />
      </div>

      {actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 bg-white p-10 text-center text-ink-400">
          <div className="text-sm">
            Action cards appear here via Supabase realtime as the action drafter writes them.
            Generate a knowledge document on the <strong>Knowledge Doc</strong> tab to populate.
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center text-ink-400 text-sm">
          No actions match the current filter.
        </div>
      ) : (
        <div className="space-y-4">
          {groupedOrder.map(([planItemId, list]) => {
            const pi = planItemsById.get(planItemId);
            return (
              <PlanItemGroup
                key={planItemId}
                planItem={pi}
                actions={list}
                busyIds={busyIds}
                errorById={errorById}
                onExecute={execute}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── building blocks ──────────────────────────────────────────────────────────
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

function TargetTile({
  icon,
  label,
  detail,
  count,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  detail: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-xl border p-4 text-left transition " +
        (active
          ? "border-ink-900 bg-ink-50"
          : "border-ink-200 bg-white hover:border-ink-400")
      }
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <span className="font-medium text-ink-900">{label}</span>
        </div>
        <span className="text-xs text-ink-400">{count}</span>
      </div>
      <div className="text-xs text-ink-400">{detail}</div>
    </button>
  );
}

function PlanItemGroup({
  planItem,
  actions,
  busyIds,
  errorById,
  onExecute,
}: {
  planItem: PlanItemRef | undefined;
  actions: GeneratedAction[];
  busyIds: Record<string, boolean>;
  errorById: Record<string, string>;
  onExecute: (a: GeneratedAction) => void;
}) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white p-4 space-y-3">
      <header className="flex items-center justify-between gap-3 border-b border-ink-100 pb-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold">
            Plan item
          </div>
          <div className="font-medium text-ink-900 truncate flex items-center gap-1.5">
            {planItem ? (
              <>
                <span>{CATEGORY_EMOJI[planItem.category]}</span>
                <span>{planItem.title}</span>
              </>
            ) : (
              <span className="text-ink-400 italic">(plan item not loaded)</span>
            )}
          </div>
        </div>
        <span className="text-xs text-ink-400 shrink-0">
          {actions.length} action{actions.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {actions.map((a) => (
          <ActionCard
            key={a.id}
            action={a}
            busy={!!busyIds[a.id]}
            error={errorById[a.id]}
            onExecute={() => onExecute(a)}
          />
        ))}
      </div>
    </section>
  );
}

function ActionCard({
  action,
  busy,
  error,
  onExecute,
}: {
  action: GeneratedAction;
  busy: boolean;
  error: string | undefined;
  onExecute: () => void;
}) {
  const meta = ACTION_META[action.action_type];
  const payload = action.payload ?? {};
  const headline = String(
    (payload as { title?: unknown }).title ??
      (payload as { task?: unknown }).task ??
      "(no title)",
  );
  const detail = String(
    (payload as { description?: unknown }).description ??
      (payload as { body?: unknown }).body ??
      "",
  ).trim();

  const isExecuted = action.status === "executed" && !!action.external_url;
  const isExecuting = action.status === "executing" || busy;
  const isFailed = action.status === "failed" || !!error;

  return (
    <article className={`rounded-lg border ${meta.tone} bg-ink-50/40 p-3 space-y-2 flex flex-col`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold flex items-center gap-1">
          <span className="text-base">{meta.emoji}</span>
          <span>{meta.label}</span>
        </div>
        <ActionStatusPill status={action.status} />
      </div>
      <div className="text-sm font-medium text-ink-900 line-clamp-2">{headline}</div>
      {detail && <p className="text-xs text-ink-600 line-clamp-3 leading-snug">{detail}</p>}
      <Payload payload={payload} type={action.action_type} />

      <div className="flex-1" />

      {error && <div className="text-[11px] text-rose-700 break-words">{error}</div>}
      {isExecuted ? (
        <a
          href={action.external_url ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="text-xs rounded-md bg-emerald-600 text-white px-2.5 py-1.5 hover:opacity-90 text-center"
        >
          Open ↗
        </a>
      ) : (
        <button
          onClick={onExecute}
          disabled={isExecuting}
          className={
            "text-xs rounded-md px-2.5 py-1.5 transition " +
            (isFailed
              ? "bg-rose-600 text-white hover:opacity-90"
              : "bg-ink-900 text-white hover:opacity-90") +
            " disabled:opacity-50"
          }
        >
          {isExecuting ? "Executing…" : isFailed ? "Retry" : "Execute"}
        </button>
      )}
    </article>
  );
}

// Payload renders a small per-type preview inside each action card.
// The action_drafter (backend/services/action_drafter.py) emits
// {branch, files_to_touch[]} for github_pr and {acceptance_criteria[]} for
// devin_handoff, but the demo seed uses a richer shape ({head_branch,
// files: [{path, patch_summary}]}, {task, starting_branch}). We accept both
// so cards render the same way regardless of which path produced the row.
function Payload({ payload, type }: { payload: Record<string, unknown>; type: ActionType }) {
  if (type === "github_pr") {
    const p = payload as {
      branch?: unknown;
      head_branch?: unknown;
      files_to_touch?: unknown;
      files?: unknown;
    };
    const branch = String(p.branch ?? p.head_branch ?? "");
    const rawFiles = Array.isArray(p.files_to_touch)
      ? p.files_to_touch
      : Array.isArray(p.files)
        ? p.files
        : [];
    const fileNames = rawFiles
      .map((f) =>
        typeof f === "string"
          ? f
          : f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string"
            ? (f as { path: string }).path
            : "",
      )
      .filter(Boolean);
    return (
      <div className="text-[11px] text-ink-400 space-y-0.5 font-mono">
        {branch && <div>branch: {branch}</div>}
        {fileNames.length > 0 && (
          <div className="break-all">
            files: {fileNames.slice(0, 2).join(", ")}
            {fileNames.length > 2 && ` +${fileNames.length - 2}`}
          </div>
        )}
      </div>
    );
  }
  if (type === "linear_ticket") {
    const priority = String((payload as { priority?: unknown }).priority ?? "");
    const labels = (payload as { labels?: unknown }).labels;
    return (
      <div className="text-[11px] text-ink-400 flex flex-wrap gap-1">
        {priority && <span className="rounded bg-ink-100 px-1.5 py-0.5">priority: {priority}</span>}
        {Array.isArray(labels) &&
          (labels as unknown[]).slice(0, 3).map((l, i) => (
            <span key={i} className="rounded bg-ink-100 px-1.5 py-0.5">
              {String(l)}
            </span>
          ))}
      </div>
    );
  }
  if (type === "devin_handoff") {
    const p = payload as {
      acceptance_criteria?: unknown;
      starting_branch?: unknown;
      repo?: unknown;
    };
    const ac = p.acceptance_criteria;
    if (Array.isArray(ac) && ac.length > 0) {
      return (
        <details className="text-[11px] text-ink-400">
          <summary className="cursor-pointer hover:text-ink-600">
            {ac.length} acceptance criteri{ac.length === 1 ? "on" : "a"}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3 list-disc">
            {(ac as unknown[]).slice(0, 3).map((x, i) => (
              <li key={i} className="break-words">
                {String(x)}
              </li>
            ))}
          </ul>
        </details>
      );
    }
    // Seed-shape fallback: surface starting_branch + repo so the card isn't blank.
    const startBranch = typeof p.starting_branch === "string" ? p.starting_branch : "";
    const repo = typeof p.repo === "string" ? p.repo : "";
    if (startBranch || repo) {
      return (
        <div className="text-[11px] text-ink-400 space-y-0.5 font-mono">
          {repo && <div>repo: {repo}</div>}
          {startBranch && <div>from: {startBranch}</div>}
        </div>
      );
    }
  }
  return null;
}

function ActionStatusPill({ status }: { status: ActionStatus }) {
  const cfg = {
    draft: { label: "draft", cls: "bg-ink-100 text-ink-600" },
    executing: { label: "executing", cls: "bg-cyan-100 text-cyan-700" },
    executed: { label: "executed", cls: "bg-emerald-100 text-emerald-700" },
    failed: { label: "failed", cls: "bg-rose-100 text-rose-700" },
  }[status];
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function FilterPicker({
  value,
  onChange,
  actions,
}: {
  value: "all" | ActionType;
  onChange: (v: "all" | ActionType) => void;
  actions: GeneratedAction[];
}) {
  const counts: Record<"all" | ActionType, number> = {
    all: actions.length,
    linear_ticket: actions.filter((a) => a.action_type === "linear_ticket").length,
    github_pr: actions.filter((a) => a.action_type === "github_pr").length,
    devin_handoff: actions.filter((a) => a.action_type === "devin_handoff").length,
  };
  const opts: { v: "all" | ActionType; label: string }[] = [
    { v: "all", label: "All" },
    { v: "linear_ticket", label: "📋" },
    { v: "github_pr", label: "🐙" },
    { v: "devin_handoff", label: "🤖" },
  ];
  return (
    <div className="flex items-center gap-1 rounded-lg border border-ink-200 p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={
            "px-2 py-1 rounded transition " +
            (value === o.v ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100")
          }
          aria-pressed={value === o.v}
        >
          <span>{o.label}</span> <span className="opacity-70">{counts[o.v]}</span>
        </button>
      ))}
    </div>
  );
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
