"use client";

import { LiveContextWhiteboard } from "./LiveContextWhiteboard";
import type { WhiteboardLayout, WhiteboardPlan } from "@/lib/whiteboardElements";
import type { ProjectContextItem } from "@/lib/realtime";

const LAYOUT_LABEL: Record<WhiteboardLayout, string> = {
  flow: "Flow",
  comparison: "Comparison",
  hierarchy: "Hierarchy",
  timeline: "Timeline",
  kanban: "Kanban",
  cluster: "Cluster",
  matrix: "Matrix",
  freeform: "Free-form",
};

const SOURCE_BADGE: Record<string, string> = {
  slack: "bg-[#fce7f3] text-[#9d174d] border-[#f9a8d4]",
  notion: "bg-[#f3f4f6] text-[#1f2937] border-[#d1d5db]",
  drive: "bg-[#fef3c7] text-[#854d0e] border-[#fcd34d]",
  gmail: "bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]",
  meeting: "bg-[#dbeafe] text-[#1e40af] border-[#93c5fd]",
  github: "bg-[#e0e7ff] text-[#3730a3] border-[#a5b4fc]",
  code: "bg-[#dcfce7] text-[#166534] border-[#86efac]",
};

export type MeetingContextBoardProps = {
  plan: WhiteboardPlan | null;
  topic?: string | null;
  planning?: boolean;
  plannerMessage?: string | null;
  contextItems?: ProjectContextItem[];
};

export function MeetingContextBoard({
  plan,
  topic,
  planning = false,
  plannerMessage = null,
  contextItems = [],
}: MeetingContextBoardProps) {
  const elements = plan?.elements ?? [];
  const hasContent = elements.length > 0;
  const visibleTopic = (topic ?? plan?.topic ?? "").trim();
  const layoutLabel = plan?.layout ? LAYOUT_LABEL[plan.layout] ?? plan.layout : null;

  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink-900">Live Whiteboard</h3>
          <div className="flex items-center gap-2 text-xs text-ink-400">
            {layoutLabel && (
              <span className="rounded-full border border-ink-200 px-2 py-0.5 text-ink-600">
                {layoutLabel}
              </span>
            )}
            {planning && <span>Planning…</span>}
          </div>
        </div>
        <p className="text-sm text-ink-400">
          {visibleTopic
            ? `Drawing for: ${summarizeTopic(visibleTopic)}`
            : "Listening for engineering context..."}
        </p>
        {plan?.rationale && (
          <p className="mt-1 text-xs italic text-ink-400">Why this layout: {plan.rationale}</p>
        )}
      </div>

      {plannerMessage && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
          Planner: {plannerMessage}
        </div>
      )}

      {hasContent ? (
        <LiveContextWhiteboard elements={elements} />
      ) : (
        <div className="rounded-lg border border-dashed border-ink-200 p-8 text-center text-sm text-ink-400">
          {planning
            ? "Planning the first whiteboard..."
            : "The whiteboard will appear when the agent has enough context."}
        </div>
      )}

      <SourcesPanel items={contextItems} />
    </section>
  );
}

function SourcesPanel({ items }: { items: ProjectContextItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase text-ink-500">
          Sources used ({items.length})
        </h4>
      </div>
      <ul className="space-y-1.5">
        {items.slice(0, 8).map((item, idx) => {
          const key = item.id ?? `${item.source}-${idx}`;
          const title =
            item.title?.trim() ||
            item.code_path ||
            item.snippet?.slice(0, 80) ||
            "Untitled";
          const badgeClass =
            SOURCE_BADGE[item.source] ?? "bg-white text-ink-600 border-ink-200";
          const showSnippet =
            item.snippet && item.title && item.title.trim() !== item.snippet.trim();
          const href = item.ref_url || item.url;

          return (
            <li key={key} className="rounded-md border border-ink-200 bg-white p-2">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}
                >
                  {item.source}
                </span>
                {item.score != null && (
                  <span className="text-xs tabular-nums text-ink-400">
                    {Math.round(item.score * 100)}%
                  </span>
                )}
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-sm font-medium text-ink-900 hover:underline"
                  >
                    {title}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                    {title}
                  </span>
                )}
              </div>
              {showSnippet && (
                <p className="mt-1 line-clamp-2 text-xs text-ink-500">{item.snippet}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function summarizeTopic(query: string) {
  return query.length > 90 ? `${query.slice(0, 87)}...` : query;
}
