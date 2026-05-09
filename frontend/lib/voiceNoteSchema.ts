export const VOICE_NOTE_TYPES = [
  "decision",
  "action_item",
  "blocker",
  "mention",
  "fyi",
] as const;

export type VoiceNoteType = (typeof VOICE_NOTE_TYPES)[number];

export type VoiceNote = {
  type: VoiceNoteType;
  text: string;
  refs_to: string[];
  embedding: number[];
};

export const VoiceNoteJsonSchema = {
  name: "voice_notes",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      notes: {
        type: "array",
        minItems: 0,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: VOICE_NOTE_TYPES },
            text: { type: "string", maxLength: 300 },
            refs_to: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["type", "text", "refs_to"],
        },
      },
    },
    required: ["notes"],
  },
  strict: true,
} as const;
