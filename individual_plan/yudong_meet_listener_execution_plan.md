# Yudong Implementation Plan: Google Meet Listener + Live Context Board

## Summary

Build the Google Meet companion listener for Project Brain. The user joins Google Meet normally, opens Project Brain, clicks **Join meeting**, selects the Meet tab with audio sharing enabled, and screen-shares the Project Brain web app.

Your core path captures meeting audio, transcribes it with OpenAI Realtime, summarizes hidden transcript chunks into structured notes, and inserts those notes into Supabase `meeting_notes`. Your bonus/demo-differentiator path renders a Yudong-owned React Flow live context board inside `VoiceAgent`, powered by `/context/query`.

## Key Changes

- Build a Yudong-owned `VoiceAgent` surface:
  - Capture Google Meet tab audio plus local mic.
  - Stream mixed audio to OpenAI Realtime over WebRTC.
  - Keep transcript chunks internal; do not make a transcript panel the main UI.
  - Every ~20 seconds, summarize transcript chunks through `/api/voice/summarize`.
  - Insert structured notes into Supabase `meeting_notes`.
- Add live context retrieval:
  - Fetch the project briefing once from `GET {FASTAPI}/context/briefing?projectId=...`.
  - Configure OpenAI Realtime with a `search_project_context` tool.
  - Handle tool calls by calling `POST {FASTAPI}/context/query`.
  - Return context results to Realtime for richer notes.
  - Also render those context results in a React Flow board owned by you.
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
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },  // not "gpt-realtime-whisper"
        turn_detection: { type: "server_vad", silence_duration_ms: 800 },
      },
    },
    ```
    Available transcription models: `gpt-4o-mini-transcribe` (fast, recommended), `gpt-4o-transcribe` (quality), `whisper-1`, `gpt-4o-transcribe-latest`.
  - Listen for `conversation.item.input_audio_transcription.delta` and `.completed` on the data channel.
- Summarization:
  - Add `POST /api/voice/summarize` in Next.js.
  - Input: `{ transcript_chunk, briefing }`.
  - Output:
    ```ts
    {
      type: "decision" | "action_item" | "blocker" | "mention" | "fyi";
      text: string;
      refs_to: string[];
    }[]
    ```
  - Use OpenAI `gpt-4.1` with JSON schema output.
- Supabase write:
  - Insert only meeting notes:
    ```ts
    await supabase.from("meeting_notes").insert({
      project_id,
      meeting_id,
      type: note.type,
      text: note.text,
      refs_to: note.refs_to,
    });
    ```
  - Do not subscribe to Supabase in your component; Jin owns realtime subscriptions.
- Live context board:
  - Use React Flow via `@xyflow/react`.
  - Keep the board inside your owned `VoiceAgent` component area unless Jin explicitly creates a larger slot for it.
  - Render current topic, context cards, and graph nodes from `/context/query` results.
  - Convert context items into nodes like topic, meeting note, Slack/Drive/Notion/Gmail item, GitHub file, decision, blocker, or action.
  - Update in snapshots when `/context/query` returns, not on every word.

## Interfaces

- Yudong calls Yash:
  - `POST {FASTAPI}/rt/token`
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
- Yudong owns:
  - meeting audio helper
  - Realtime WebRTC helper
  - voice note schema
  - `/api/voice/summarize`
  - `VoiceAgent`
  - `BriefingPanel`
  - `MeetingContextBoard`
  - `LiveContextDiagram`
  - demo standup script

## Test Plan

- Mic-only smoke test:
  - Start listener with mic-only fallback.
  - Confirm Realtime transcript events arrive.
  - Confirm `/api/voice/summarize` returns valid structured notes.
- Google Meet capture test:
  - Join a Meet.
  - Start listener.
  - Select Meet tab and enable tab audio.
  - Confirm remote speaker audio and local mic both reach Realtime.
- Supabase test:
  - Insert summarized notes using anon key.
  - Confirm insert succeeds into `meeting_notes`.
  - Confirm Jin's Inputs tab receives entries.
- Context board test:
  - Say "Safari login flow," "CSV export," and "rate-limit middleware."
  - Confirm `/context/query` returns relevant items.
  - Confirm React Flow diagram updates with topic, sources, and follow-up context.
- Demo fallback:
  - If tab audio fails, use mic-only and play the standup script audio through laptop speakers.

## Assumptions

- Yash provides working FastAPI endpoints: `/rt/token`, `/context/briefing`, and `/context/query`.
- Jin provides Supabase project, anon key, RLS allowing anon insert into `meeting_notes`, and mounts `VoiceAgent` in Inputs -> Meetings.
- The user runs Chrome for Google Meet tab audio capture.
- The main persisted output is structured `meeting_notes`; React Flow is a live context aid owned by Yudong, not part of the five-table synthesis pipeline.
- React Flow is the diagram library; no Excalidraw/autopreso dependency for MVP.
