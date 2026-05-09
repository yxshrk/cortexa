"use client";

import { use, useState } from "react";
import Link from "next/link";
import ConnectorsTab from "./_tabs/ConnectorsTab";
import InputsTab from "./_tabs/InputsTab";
import KnowledgeDocTab from "./_tabs/KnowledgeDocTab";
import ActionsTab from "./_tabs/ActionsTab";

type Tab = "inputs" | "connectors" | "knowledge" | "actions";

const TABS: { id: Tab; label: string }[] = [
  { id: "inputs",      label: "📥 Inputs" },
  { id: "connectors",  label: "🔌 Connectors" },
  { id: "knowledge",   label: "🧠 Knowledge Doc" },
  { id: "actions",     label: "⚡ Actions" },
];

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  const [tab, setTab] = useState<Tab>("connectors");

  return (
    <main className="mx-auto max-w-7xl p-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-ink-400 hover:text-ink-900">
            ← all projects
          </Link>
          <h1 className="text-2xl font-bold mt-1">Project · {projectId.slice(0, 8)}</h1>
        </div>
      </header>

      <nav className="border-b border-ink-200 mb-6">
        <ul className="flex gap-1">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setTab(t.id)}
                className={
                  "px-4 py-2 -mb-px border-b-2 transition " +
                  (tab === t.id
                    ? "border-ink-900 text-ink-900 font-semibold"
                    : "border-transparent text-ink-400 hover:text-ink-600")
                }
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "inputs"     && <InputsTab projectId={projectId} />}
      {tab === "connectors" && <ConnectorsTab projectId={projectId} />}
      {tab === "knowledge"  && <KnowledgeDocTab projectId={projectId} />}
      {tab === "actions"    && <ActionsTab projectId={projectId} />}
    </main>
  );
}
