"use client";

import { useState } from "react";
import ConnectorsTab from "./ConnectorsTab";
import MeetingNotesPanel from "./_panels/MeetingNotesPanel";

type SubMode = "connectors" | "meetings";

const MODES: { id: SubMode; label: string; icon: string; blurb: string }[] = [
  {
    id: "connectors",
    label: "Connectors",
    icon: "🔌",
    blurb: "Async knowledge. Slack, Drive, Notion, GitHub — pulled via Hyperspell on a 5-min cron.",
  },
  {
    id: "meetings",
    label: "Meeting Notes",
    icon: "🎙️",
    blurb: "Live knowledge. Captured by the voice agent during meetings and saved as structured notes.",
  },
];

export default function CompanyKnowledgeTab({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<SubMode>("connectors");
  const active = MODES.find((m) => m.id === mode)!;

  return (
    <div className="space-y-5">
      {/* Sub-mode toggle */}
      <div className="rounded-xl border border-ink-200 bg-white p-1 inline-flex">
        {MODES.map((m) => {
          const isActive = m.id === mode;
          return (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={
                "px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 " +
                (isActive
                  ? "bg-ink-900 text-white shadow-sm"
                  : "text-ink-600 hover:bg-ink-100")
              }
            >
              <span>{m.icon}</span>
              <span>{m.label}</span>
            </button>
          );
        })}
      </div>

      {/* Mode descriptor */}
      <div className="text-sm text-ink-400">{active.blurb}</div>

      {/* Panel */}
      {mode === "connectors" && <ConnectorsTab projectId={projectId} />}
      {mode === "meetings"   && <MeetingNotesPanel projectId={projectId} />}
    </div>
  );
}
