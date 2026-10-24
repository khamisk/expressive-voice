export type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string } };
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
};

export function transcriptDelta(event: RealtimeServerEvent): string | null {
  return event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string"
    ? event.delta
    : null;
}

export function inputTranscriptDelta(event: RealtimeServerEvent): string | null {
  if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
    return event.delta;
  }
  return null;
}

export function completedTranscript(event: RealtimeServerEvent, source: "input" | "output"): string | null {
  const expectedType = source === "input"
    ? "conversation.item.input_audio_transcription.completed"
    : "response.output_audio_transcript.done";
  return event.type === expectedType && typeof event.transcript === "string" ? event.transcript : null;
}

export function realtimeErrorMessage(event: RealtimeServerEvent): string | null {
  if (event.type === "error") {
    return event.error?.message ?? "The live voice connection had a problem.";
  }
  if (event.type === "response.done" && event.response?.status === "failed") {
    return event.response.status_details?.error?.message ?? "The voice response failed.";
  }
  return null;
}
