"use client";

export default function ActionsTab({ projectId: _ }: { projectId: string }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-ink-200 bg-white p-5">
        <div className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">
          Generated from Knowledge Doc
        </div>
        <h2 className="text-lg font-semibold text-ink-900 mt-0.5">Action queue</h2>
        <p className="text-xs text-ink-400 mt-1">
          Each card is a <code>generated_actions</code> row. Execute fans out to Linear (issues),
          GitHub (PRs / comments), or Devin (autonomous code tasks).
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TargetTile icon="📋" label="Linear" detail="Create issue · update status" />
        <TargetTile icon="🐙" label="GitHub" detail="Open PR · file comment" />
        <TargetTile icon="🤖" label="Devin"  detail="Spawn autonomous task" />
      </div>

      <div className="rounded-xl border border-dashed border-ink-200 bg-white p-10 text-center text-ink-400">
        <div className="text-sm">
          Action cards appear here via Supabase realtime as Claude drafts them. Each has an Execute
          button → <code>POST /actions/{`{id}`}/execute</code>.
        </div>
      </div>
    </div>
  );
}

function TargetTile({ icon, label, detail }: { icon: string; label: string; detail: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{icon}</span>
        <span className="font-medium text-ink-900">{label}</span>
      </div>
      <div className="text-xs text-ink-400">{detail}</div>
    </div>
  );
}
