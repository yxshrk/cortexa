import OpenAI from "openai";
import { VoiceNoteJsonSchema } from "@/lib/voiceNoteSchema";

type Briefing = {
  project_summary?: string;
  themes?: string[];
  active_files?: { path?: string }[];
};

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const openai = new OpenAI({ apiKey });
  const { transcript_chunk, briefing } = (await req.json()) as {
    transcript_chunk?: string;
    briefing?: Briefing;
  };

  if (!transcript_chunk?.trim()) {
    return Response.json({ notes: [] });
  }

  const context = briefing ?? {};
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    response_format: {
      type: "json_schema",
      json_schema: VoiceNoteJsonSchema,
    },
    messages: [
      {
        role: "system",
        content: [
          "You turn engineering meeting transcript chunks into 1-3 concise structured notes.",
          `Project: ${context.project_summary ?? "Unknown project"}`,
          `Themes: ${(context.themes ?? []).join(", ")}`,
          `Active files: ${(context.active_files ?? []).map((file) => file.path).filter(Boolean).join(", ")}`,
          "Each note must be one of: decision, action_item, blocker, mention, fyi.",
        ].join("\n"),
      },
      { role: "user", content: transcript_chunk },
    ],
  });

  const parsed = JSON.parse(completion.choices[0]?.message.content ?? "{\"notes\":[]}") as {
    notes: { type: string; text: string; refs_to: string[] }[];
  };

  const texts = parsed.notes.map((note) => note.text);
  if (texts.length === 0) {
    return Response.json({ notes: [] });
  }

  const embeddings = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });

  const notes = parsed.notes.map((note, index) => ({
    ...note,
    embedding: embeddings.data[index]?.embedding ?? [],
  }));

  return Response.json({ notes });
}
