"use client";

export default function ActionsTab({ projectId: _ }: { projectId: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
      <div className="text-lg mb-1">⚡ Actions tab — Jin owns this</div>
      <div className="text-sm">
        Cards from <code>generated_actions</code> via realtime. Each card has an Execute button
        that POSTs to <code>/actions/{`{id}`}/execute</code>.
      </div>
    </div>
  );
}
