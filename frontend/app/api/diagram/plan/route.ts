import OpenAI from "openai";
import { DiagramPlanJsonSchema, fallbackDiagramPlan } from "@/lib/diagramPlan";
import type { ProjectContextItem } from "@/lib/realtime";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const { topic, contextItems } = (await req.json()) as {
    topic?: string;
    contextItems?: ProjectContextItem[];
  };

  const trimmedTopic = topic?.trim();
  if (!trimmedTopic) {
    return Response.json({ error: "topic is required" }, { status: 400 });
  }

  const items = (contextItems ?? []).slice(0, 10);
  if (items.length === 0) {
    return Response.json(fallbackDiagramPlan(trimmedTopic, []));
  }

  const openai = new OpenAI({ apiKey });
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    response_format: {
      type: "json_schema",
      json_schema: DiagramPlanJsonSchema,
    },
    messages: [
      {
        role: "system",
        content: [
          "You are a diagram planner for engineering meetings.",
          "Create a compact whiteboard-style graph that helps participants understand the current discussion.",
          "Use only the provided context items. Do not invent files, APIs, tables, or decisions.",
          "Prefer nodes that explain ownership, data flow, dependencies, decisions, blockers, and open questions.",
          "Every node label should be short. Put explanation in detail.",
          "Include exactly one topic node with id 'topic' and group 'topic'.",
          "Connect the topic to the most important nodes, and connect related nodes when there is a clear flow.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          topic: trimmedTopic,
          contextItems: items.map((item) => ({
            source: item.source,
            title: item.title,
            snippet: item.snippet,
            code_path: item.code_path,
            code_lines: item.code_lines,
            score: item.score,
          })),
        }),
      },
    ],
  });

  try {
    return Response.json(
      JSON.parse(completion.choices[0]?.message.content ?? ""),
    );
  } catch {
    return Response.json(fallbackDiagramPlan(trimmedTopic, items));
  }
}
