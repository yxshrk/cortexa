"use client";

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}

if (!supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const FASTAPI_URL =
  process.env.NEXT_PUBLIC_FASTAPI_URL ?? "http://localhost:8000";

export const CONNECTORS = [
  { id: "slack", label: "Slack", emoji: "💬" },
  { id: "drive", label: "Drive", emoji: "📄" },
  { id: "notion", label: "Notion", emoji: "📝" },
  { id: "gmail", label: "Gmail", emoji: "✉️" },
  { id: "github", label: "GitHub", emoji: "🐙" },
] as const;

export type ConnectorId = (typeof CONNECTORS)[number]["id"];

export function authHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.NEXT_PUBLIC_DEMO_TOKEN ?? ""}`,
  };
}
