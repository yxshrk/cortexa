import type { ProjectContextItem } from "@/lib/realtime";

export async function queryProjectContext({
  fastApiUrl,
  projectId,
  query,
  k = 6,
}: {
  fastApiUrl: string;
  projectId: string;
  query: string;
  k?: number;
}) {
  const response = await fetch(`${fastApiUrl}/context/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, query, k }),
  });

  if (!response.ok) {
    throw new Error(`Context query failed: ${response.status}`);
  }

  return (await response.json()) as ProjectContextItem[];
}
