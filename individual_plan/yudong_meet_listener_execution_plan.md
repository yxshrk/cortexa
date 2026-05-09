# Yudong Implementation Plan: Google Meet Listener + Live Context Board

## Summary

Build the Google Meet companion listener for Project Brain. The user joins Google Meet normally, opens Project Brain, clicks **Join meeting**, selects the Meet tab with audio sharing enabled, and screen-shares the Project Brain web app.

Your core path captures meeting audio, transcribes it with OpenAI Realtime, summarizes hidden transcript chunks into structured notes, embeds those notes with `text-embedding-3-small`, and inserts them into Supabase `meeting_notes`. Your live context path renders a Yudong-owned React Flow board inside `VoiceAgent`, powered by `/context/query`.

## Key Changes

- Build a Yudong-owned `VoiceAgent` surface:
  - Capture Google Meet tab audio plus local mic.
  - Stream mixed audio to OpenAI Realtime over WebRTC.
  - Keep transcript chunks internal; do not make a transcript panel the main UI.
  - Store raw transcript chunks in `meeting_transcript_chunks` when available.
  - Every completed utterance or ~20 seconds, summarize transcript chunks through `/api/voice/summarize`.
  - Insert structured, embedded notes into Supabase `meeting_notes`.
- Add live context retrieval:
  - Fetch the project briefing once from `GET {FASTAPI}/context/briefing?projectId=...`.
  - Configure OpenAI Realtime with a `search_project_context` tool.
  - Let the Realtime model decide when the meeting needs project context.
  - Do not run frontend keyword/rate-limit trigger logic for context lookup in the MVP.
  - Handle model tool calls by calling `POST {FASTAPI}/context/query`.
  - Return context results to Realtime for richer notes.
  - Render those context results in a React Flow board owned by you.
- Use Google Meet only:
  - No Zoom.
  - No real meeting bot joining as a participant.
  - User-authorized browser tab audio capture is the MVP path.

## Implementation Details

- Audio capture:
  - **`getDisplayMedia` REQUIRES a video track per spec — passing `video: false` throws TypeError.** Request video, immediately stop and remove the video track, keep the audio track.
    ```ts
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    display.getVideoTracks().forEach(t => { t.stop(); display.removeTrack(t); });
    if (display.getAudioTracks().length === 0) throw new Error("TAB_AUDIO_MISSING");
    ```
  - User selects the Google Meet tab and checks **Share tab audio**.
  - Use `navigator.mediaDevices.getUserMedia({ audio: true })` for local mic.
  - Mix both streams with `AudioContext` and `MediaStreamDestination`.
  - On `TAB_AUDIO_MISSING`, surface a toast and fall back to mic-only.
- Realtime transcription:
  - Call `POST {FASTAPI}/rt/token` for OpenAI ephemeral token. Frozen response shape: `{ value, expires_at }`. Use `body.value` directly as the WebRTC bearer.
  - Create `RTCPeerConnection`, add the mixed audio track, and listen on `RTCDataChannel`.
  - Send `session.update` with project briefing terms, the `search_project_context` tool, AND explicit transcription config (otherwise no events fire):
    ```ts
    dc.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: BRIEFING_PROMPT,
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" }, // not "gpt-realtime-whisper"
            turn_detection: { type: "server_vad", silence_duration_ms: 800 },
          },
        },
        tools: TOOLS,
        tool_choice: "auto",
      },
    }));
    ```
    Available transcription models: `gpt-4o-mini-transcribe` (fast, recommended), `gpt-4o-transcribe` (quality), `whisper-1`, `gpt-4o-transcribe-latest`.
- Realtime event handling:
  - Buffer `conversation.item.input_audio_transcription.delta`.
  - Finalize/summarize on `conversation.item.input_audio_transcription.completed`.
  - Handle `response.function_call_arguments.done` when `name === "search_project_context"`.
- Summarization and embeddings:
  - Add `POST /api/voice/summarize` in Next.js.
  - Input: `{ transcript_chunk, briefing }`.
  - Generate structured notes with `gpt-4.1`.
  - Embed each note text with `text-embedding-3-small`.
  - Output:
    ```ts
    {
      type: "decision" | "action_item" | "blocker" | "mention" | "fyi";
      text: string;
      refs_to: string[];
      embedding: number[]; // 1536 floats
    }[]
    ```
- Supabase writes:
  - Insert summarized notes into `meeting_notes`:
    ```ts
    await supabase.from("meeting_notes").insert({
      project_id,
      meeting_id,
      type: note.type,
      text: note.text,
      refs_to: note.refs_to,
      embedding: note.embedding,
    });
    ```
  - Insert raw transcript chunks into `meeting_transcript_chunks` when chunk timing is available:
    ```ts
    await supabase.from("meeting_transcript_chunks").insert({
      meeting_id,
      speaker,
      start_ms,
      end_ms,
      text,
    });
    ```
  - Do not subscribe to Supabase in your component; Jin owns realtime subscriptions.
- Live context board:
  - Use React Flow via `@xyflow/react`.
  - Keep the board inside your owned `VoiceAgent` component boundary.
  - Render current topic, context cards, and graph nodes only from model-triggered `/context/query` results.
  - Convert context items into nodes like topic, meeting note, Slack/Drive/Notion/Gmail item, GitHub file, decision, blocker, or action.
  - If the model does not call `search_project_context`, leave the board in a listening/empty state.
  - Preserve the last useful board if `/context/query` fails.
  - Do not block meeting note insertion on React Flow or context search failure.
  - Keep a manual demo fallback button/query available for rehearsal only, not as the main product behavior.

## Interfaces

- Yudong calls Yash:
  - `POST {FASTAPI}/rt/token` -> `{ value, expires_at }`
  - `GET {FASTAPI}/context/briefing?projectId=<uuid>`
  - `POST {FASTAPI}/context/query` with `{ projectId, query, k: 6 }`
- Yudong exposes to Jin:
  ```tsx
  export function VoiceAgent({
    projectId,
    meetingId,
  }: {
    projectId: string;
    meetingId: string;
  }) {}
  ```
  `meetingId` is an internal Supabase `meetings.id` supplied by Jin's page. It is not a Google Meet ID or URL. Your component should assume the row already exists and use it only to group `meeting_notes` and `meeting_transcript_chunks`.
- Yudong owns:
  - `frontend/lib/meetingAudio.ts`
  - `frontend/lib/realtime.ts`
  - `frontend/lib/voiceNoteSchema.ts`
  - `frontend/app/api/voice/summarize/route.ts`
  - `frontend/components/VoiceAgent.tsx`
  - `frontend/components/BriefingPanel.tsx`
  - `frontend/components/MeetingContextBoard.tsx`
  - `frontend/components/LiveContextDiagram.tsx`
  - `demo/standup_script.md`

## Test Plan

- Mic-only smoke test:
  - Start listener with mic-only fallback.
  - Confirm Realtime transcript events arrive after `session.update`.
  - Confirm `/api/voice/summarize` returns notes with `embedding`.
- Google Meet capture test:
  - Join a Meet in Chrome.
  - Start listener.
  - Select Meet tab and enable tab audio.
  - Confirm video track is removed and tab audio remains.
  - Confirm remote speaker audio and local mic both reach Realtime.
- Supabase test:
  - Insert a summarized note using anon key.
  - Confirm insert succeeds into `meeting_notes` with `embedding`.
  - Insert a raw chunk into `meeting_transcript_chunks`.
  - Confirm Jin's Inputs tab receives meeting notes.
- Context board test:
  - Say "Safari login flow," "CSV export," and "rate-limit middleware."
  - Confirm the model chooses to call `search_project_context`.
  - Confirm the tool handler calls `/context/query` and receives relevant items.
  - Confirm React Flow diagram updates with topic, sources, and follow-up context.
  - Confirm the manual demo fallback can update the board if model tool-calling is unreliable.
- Demo fallback:
  - If tab audio fails, ask the user to re-pick the Meet tab with **Share tab audio**.
  - If still failing, use mic-only and play the standup script audio through laptop speakers.

## Assumptions

- Yash provides working FastAPI endpoints: `/rt/token`, `/context/briefing`, and `/context/query`.
- Jin provides Supabase project, anon key, pgvector schema, RLS allowing anon insert into `meeting_notes` and `meeting_transcript_chunks`, and mounts `VoiceAgent` in Inputs -> Meetings.
- Jin provides a valid internal `meetingId` from the current project's latest live or pre-seeded `meetings` row; Yudong does not create `meetings` rows.
- The user runs Chrome for Google Meet tab audio capture.
- The main persisted output is embedded structured `meeting_notes`; raw transcript chunks are audit trail only.
- React Flow is a live context aid owned by Yudong, not part of the five-table synthesis pipeline.
- Diagram updates are model-triggered through `search_project_context`, not frontend keyword-triggered.
- React Flow is the diagram library; no Excalidraw/autopreso dependency for MVP.
