// Realtime ASR connection. Phase-1 architecture: this is now transcription-
// only. The model no longer calls tools; all reasoning + retrieval + diagram
// planning happens server-side behind a debounced turn queue (see
// backend/routers/whiteboard.py).
//
// We keep using `gpt-realtime-2` rather than the dedicated transcription
// session because the existing token endpoint and SDP exchange flow already
// works with it, and we may later re-add lightweight voice replies.

export type RealtimeTranscriptEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; text: string };

export type ProjectContextItem = {
  origin?: "local" | "hyperspell";
  source: string;
  id?: string;
  title?: string | null;
  snippet?: string | null;
  ref_url?: string | null;
  url?: string | null;
  ts?: string | null;
  score?: number;
  code_path?: string | null;
  code_lines?: string | null;
};

export type RealtimeConnection = {
  close: () => void;
};

export type ConnectRealtimeOptions = {
  stream: MediaStream;
  token: string;
  briefingPrompt: string;
  onTranscript: (event: RealtimeTranscriptEvent) => void;
  onError: (error: Error) => void;
};

const REALTIME_MODEL = "gpt-realtime-2";

export async function connectRealtime(
  options: ConnectRealtimeOptions,
): Promise<RealtimeConnection> {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("oai-events");

  for (const track of options.stream.getAudioTracks()) {
    pc.addTrack(track, options.stream);
  }

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      options.onError(new Error("Realtime peer connection failed"));
    }
  });

  dc.addEventListener("open", () => {
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: options.briefingPrompt,
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-transcribe",
                language: "en",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
            },
          },
        },
      }),
    );
  });

  dc.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data as string) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string; type?: string; code?: string };
      };

      if (payload.type === "error") {
        const errorMessage =
          payload.error?.message ?? payload.error?.type ?? "Realtime session error.";
        options.onError(new Error(errorMessage));
        return;
      }

      if (payload.type === "conversation.item.input_audio_transcription.delta") {
        options.onTranscript({ type: "delta", text: payload.delta ?? "" });
        return;
      }

      if (payload.type === "conversation.item.input_audio_transcription.completed") {
        options.onTranscript({ type: "completed", text: payload.transcript ?? "" });
        return;
      }
    } catch (error) {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/sdp",
    },
    body: offer.sdp,
  });

  if (!sdpResponse.ok) {
    throw new Error(
      `Realtime SDP exchange failed: ${sdpResponse.status} ${await sdpResponse.text()}`,
    );
  }

  const answer = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  return {
    close: () => {
      dc.close();
      pc.close();
      options.stream.getTracks().forEach((track) => track.stop());
    },
  };
}
