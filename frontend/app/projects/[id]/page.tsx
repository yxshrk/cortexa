"use client";

import { use, useState } from "react";
import Link from "next/link";
import CompanyKnowledgeTab from "./_tabs/CompanyKnowledgeTab";
import KnowledgeDocTab from "./_tabs/KnowledgeDocTab";
import ActionsTab from "./_tabs/ActionsTab";

type Tab = "knowledge_inputs" | "knowledge_doc" | "actions";

const SECTIONS: {
  id: Tab;
  label: string;
  sub: string;
  step: string;
  title: string;
}[] = [
  {
    id: "knowledge_inputs",
    label: "Company Knowledge",
    sub: "Connectors · Meetings",
    step: "Step 1 · Capture",
    title: "Company Knowledge",
  },
  {
    id: "knowledge_doc",
    label: "Knowledge Document",
    sub: "Synthesis · Codebase refs",
    step: "Step 2 · Synthesize",
    title: "Knowledge Document",
  },
  {
    id: "actions",
    label: "Actions",
    sub: "Linear · GitHub · Devin",
    step: "Step 3 · Execute",
    title: "Actions",
  },
];

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  const [tab, setTab] = useState<Tab>("knowledge_inputs");
  const active = SECTIONS.find((section) => section.id === tab) ?? SECTIONS[0];

  return (
    <main className="min-h-screen bg-ink-50">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 flex h-screen w-[280px] shrink-0 flex-col border-r border-ink-200 bg-panel px-4 py-5">
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-1 text-[12px] font-medium text-ink-400 transition-colors duration-150 hover:text-ink-900"
          >
            ← all projects
          </Link>

          <div className="mb-8">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">Project</div>
            <div className="mt-1 truncate text-[17px] font-semibold tracking-[-0.2px] text-ink-900" title={projectId}>
              {projectId.slice(0, 8)}
            </div>
          </div>

          <nav className="space-y-0.5">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
              Workspace
            </div>
            {SECTIONS.map((item) => {
              const selected = item.id === tab;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={
                    "w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 " +
                    (selected
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-900")
                  }
                >
                  <span className="block text-[13px] font-semibold">{item.label}</span>
                  <span className={"mt-0.5 block text-[11px] " + (selected ? "text-white/60" : "text-ink-400")}>
                    {item.sub}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="mt-auto rounded-xl border border-ink-200 bg-ink-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-400 mb-1.5">Flow</div>
            <p className="text-[12px] leading-5 text-ink-500">
              Connectors and meetings feed the knowledge doc. The knowledge doc generates actions.
            </p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1520px] px-8 py-7">
            <div className="mb-6">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
                {active.step}
              </div>
              <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.4px] text-ink-900">
                {active.title}
              </h1>
            </div>

            {tab === "knowledge_inputs" && <CompanyKnowledgeTab projectId={projectId} />}
            {tab === "knowledge_doc" && <KnowledgeDocTab projectId={projectId} />}
            {tab === "actions" && <ActionsTab projectId={projectId} />}
          </div>
        </section>
      </div>
    </main>
  );
}
