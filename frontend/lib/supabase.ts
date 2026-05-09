"use client";

import { createClient } from "@supabase/supabase-js";

// Browser client. MUST use the publishable / anon key (NEVER the secret key).
// Accepts either env var name:
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (current Supabase naming)
//   NEXT_PUBLIC_SUPABASE_ANON_KEY         (legacy / older projects)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}
if (!supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

export const FASTAPI_URL =
  process.env.NEXT_PUBLIC_FASTAPI_URL ?? "http://localhost:8000";
export const DEMO_TOKEN = process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "";

export function authHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...(DEMO_TOKEN ? { authorization: `Bearer ${DEMO_TOKEN}` } : {}),
  };
}

// Connector source enums — matches DB `context_source` enum.
//
// `unsupported`: source is in our DB schema but Hyperspell doesn't expose it.
//   /connect/start will 400 — UI should disable the connect button and show a tooltip.
// `beta`: source exists in Hyperspell but is in beta on our side; we use it in
//   /plan/generate (code_refs) rather than in the connect flow.
//
// Live-tested 2026-05-09: Hyperspell `integrations.list()` returns 4 providers:
//   slack, notion, google_drive, github. Gmail is not yet supported.
export const CONNECTORS = [
  { id: "slack", label: "Slack", emoji: "💬" },
  { id: "drive", label: "Drive", emoji: "📄" },
  { id: "notion", label: "Notion", emoji: "📝" },
  { id: "gmail", label: "Gmail", emoji: "✉️", unsupported: true,
    tooltip: "Hyperspell doesn't expose Gmail yet — coming soon." },
  { id: "github", label: "GitHub", emoji: "🐙", beta: true,
    tooltip: "Used for code references in /plan/generate, not as a connect-flow source." },
] as const;
export type ConnectorId = (typeof CONNECTORS)[number]["id"];
