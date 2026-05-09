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
export const CONNECTORS = [
  { id: "slack", label: "Slack", emoji: "💬" },
  { id: "drive", label: "Drive", emoji: "📄" },
  { id: "notion", label: "Notion", emoji: "📝" },
  { id: "gmail", label: "Gmail", emoji: "✉️" },
  { id: "github", label: "GitHub", emoji: "🐙" },
] as const;
export type ConnectorId = (typeof CONNECTORS)[number]["id"];
