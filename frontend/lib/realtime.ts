export type RealtimeTranscriptEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; text: string };

export type ProjectContextItem = {
  source: string;
  title?: string | null;
  snippet?: string | null;
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
  projectId: string;
  fastApiUrl: string;
  queryContext?: (query: string) => Promise<ProjectContextItem[]>;
  onTranscript: (event: RealtimeTranscriptEvent) => void;
  onContextItems: (query: string, items: ProjectContextItem[]) => void;
  onError: (error: Error) => void;
};

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
          model: "gpt-realtime",
          instructions: options.briefingPrompt,
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
                prompt:
                  "Engineering meeting about frontend code, React Flow, repositories, Supabase, FastAPI, and Google Meet.",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
            },
          },
          tools: [
            {
              type: "function",
              name: "search_project_context",
              description:
                "Search this project's knowledge base for files, decisions, or threads relevant to the engineering topic currently being discussed.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description:
                      "A concise search query for the current engineering topic.",
                  },
                },
                required: ["query"],
              },
            },
          ],
          tool_choice: "auto",
        },
      }),
    );
  });

  dc.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data as string) as {
        type?: string;
        delta?: string;
        transcript?: string;
        name?: string;
        arguments?: string;
        call_id?: string;
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

      if (
        payload.type === "response.function_call_arguments.done" &&
        payload.name === "search_project_context" &&
        payload.call_id
      ) {
        const args = JSON.parse(payload.arguments ?? "{}") as { query?: string };
        const query = args.query?.trim();
        if (!query) return;

        const items = options.queryContext
          ? await options.queryContext(query)
          : await fetch(`${options.fastApiUrl}/context/query`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ projectId: options.projectId, query, k: 6 }),
            })
              .then((res) => (res.ok ? res.json() : Promise.reject(res.statusText)))
              .catch((error) => {
                options.onError(
                  error instanceof Error ? error : new Error(String(error)),
                );
                return [];
              });

        options.onContextItems(query, items as ProjectContextItem[]);

        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: payload.call_id,
              output: JSON.stringify(items),
            },
          }),
        );
        dc.send(JSON.stringify({ type: "response.create" }));
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
