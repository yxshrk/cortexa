"use client";

import { use, useState } from "react";
import Link from "next/link";
import CompanyKnowledgeTab from "./_tabs/CompanyKnowledgeTab";
import KnowledgeDocTab from "./_tabs/KnowledgeDocTab";
import ActionsTab from "./_tabs/ActionsTab";

type Tab = "knowledge_inputs" | "knowledge_doc" | "actions";

const SECTIONS: { heading: string; items: { id: Tab; label: string; icon: string; sub?: string }[] }[] = [
  {
    heading: "Workspace",
    items: [
      { id: "knowledge_inputs", label: "Company Knowledge", icon: "📚", sub: "Connectors · Meetings" },
      { id: "knowledge_doc",    label: "Knowledge Document", icon: "🧠", sub: "Synthesis · Codebase refs" },
      { id: "actions",          label: "Actions",            icon: "⚡", sub: "Linear · GitHub · Devin" },
    ],
  },
];

const FLOW_LABEL: Record<Tab, string> = {
  knowledge_inputs: "Step 1 · Capture",
  knowledge_doc:    "Step 2 · Synthesize",
  actions:          "Step 3 · Execute",
};

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  const [tab, setTab] = useState<Tab>("knowledge_inputs");

  return (
    <main className="min-h-screen bg-ink-50">
      <div className="mx-auto flex max-w-[1600px]">
        {/* ───── Left sidebar ───── */}
        <aside className="sticky top-0 h-screen w-64 shrink-0 border-r border-ink-200 bg-white px-4 py-5 flex flex-col">
          <Link
            href="/"
            className="text-xs text-ink-400 hover:text-ink-900 mb-1 inline-flex items-center gap-1"
          >
            ← all projects
          </Link>
          <div className="mb-6">
            <div className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold">Project</div>
            <div className="font-bold text-ink-900 truncate" title={projectId}>
              {projectId.slice(0, 8)}
            </div>
          </div>

          {SECTIONS.map((section) => (
            <div key={section.heading} className="mb-6">
              <div className="px-2 mb-2 text-[10px] uppercase tracking-wider text-ink-400 font-semibold">
                {section.heading}
              </div>
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const active = tab === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        onClick={() => setTab(item.id)}
                        className={
                          "w-full text-left rounded-lg px-3 py-2.5 transition flex items-start gap-3 " +
                          (active
                            ? "bg-ink-900 text-white shadow-sm"
                            : "text-ink-600 hover:bg-ink-100")
                        }
                      >
                        <span className="text-base leading-5">{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className={"block text-sm font-medium " + (active ? "text-white" : "text-ink-900")}>
                            {item.label}
                          </span>
                          {item.sub && (
                            <span className={"block text-[11px] mt-0.5 " + (active ? "text-white/60" : "text-ink-400")}>
                              {item.sub}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <div className="mt-auto rounded-lg border border-ink-200 bg-ink-50 p-3 text-[11px] text-ink-400 leading-relaxed">
            <span className="font-semibold text-ink-600 block mb-1">The flow</span>
            Connectors + Meetings → Knowledge Doc → Actions
          </div>
        </aside>

        {/* ───── Main content ───── */}
        <section className="flex-1 min-w-0">
          <div className="px-8 py-6">
            <div className="mb-5">
              <div className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">
                {FLOW_LABEL[tab]}
              </div>
              <h1 className="text-2xl font-bold text-ink-900 mt-0.5">
                {SECTIONS[0].items.find((i) => i.id === tab)?.label}
              </h1>
            </div>

            {tab === "knowledge_inputs" && <CompanyKnowledgeTab projectId={projectId} />}
            {tab === "knowledge_doc"    && <KnowledgeDocTab projectId={projectId} />}
            {tab === "actions"          && <ActionsTab projectId={projectId} />}
          </div>
        </section>
      </div>
    </main>
  );
}
