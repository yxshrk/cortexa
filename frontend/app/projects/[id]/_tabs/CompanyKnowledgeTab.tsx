"use client";

import { useState } from "react";
import ConnectorsTab from "./ConnectorsTab";
import MeetingNotesPanel from "./_panels/MeetingNotesPanel";

type SubMode = "connectors" | "meetings";

const MODES: { id: SubMode; label: string; icon: string; blurb: string }[] = [
  {
    id: "connectors",
    label: "Connectors",
    icon: "↔",
    blurb: "Async knowledge. Slack, Drive, Notion, GitHub — pulled via Hyperspell on a 5-min cron.",
  },
  {
    id: "meetings",
    label: "Meeting Notes",
    icon: "◌",
    blurb: "Live knowledge. Captured by the voice agent during meetings and saved as structured notes.",
  },
];

export default function CompanyKnowledgeTab({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<SubMode>("connectors");
  const active = MODES.find((m) => m.id === mode)!;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-ink-200 bg-panel">
        <div className="flex flex-col gap-4 border-b border-ink-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.2px] text-ink-900">Inputs</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-ink-500">{active.blurb}</p>
          </div>
          <div className="inline-flex w-fit rounded-lg border border-ink-200 bg-ink-50 p-1">
            {MODES.map((m) => {
              const isActive = m.id === mode;
              return (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={
                    "flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 " +
                    (isActive
                      ? "bg-panel text-ink-900 shadow-sm"
                      : "text-ink-500 hover:text-ink-900")
                  }
                >
                  <span className="text-[12px] text-ink-400">{m.icon}</span>
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-0 md:grid-cols-3">
          <FlowTile label="Connect" value="Authorize sources and refresh indexed context." />
          <FlowTile label="Capture" value="Save live meeting notes into project memory." />
          <FlowTile label="Synthesize" value="Feed knowledge documents and actions." last />
        </div>
      </section>

      {mode === "connectors" && <ConnectorsTab projectId={projectId} />}
      {mode === "meetings"   && <MeetingNotesPanel projectId={projectId} />}
    </div>
  );
}

function FlowTile({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={"p-4 " + (last ? "" : "border-b border-ink-200 md:border-b-0 md:border-r")}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-900">{label}</div>
      <p className="mt-1 text-[12px] leading-5 text-ink-500">{value}</p>
    </div>
  );
}
