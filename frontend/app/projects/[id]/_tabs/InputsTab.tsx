"use client";

export default function InputsTab({ projectId: _ }: { projectId: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
      <div className="text-lg mb-1">📥 Inputs tab — Jin owns this</div>
      <div className="text-sm">
        Two sub-sections: Meetings (mounts Yudong&apos;s <code>&lt;VoiceAgent /&gt;</code> +{" "}
        <code>&lt;MeetingsList /&gt;</code>) · Project Context (similar to the Connectors view but
        cross-source).
      </div>
    </div>
  );
}
