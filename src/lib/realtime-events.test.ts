import { describe, expect, it } from "vitest";
import { completedTranscript, inputTranscriptDelta, realtimeErrorMessage, transcriptDelta } from "./realtime-events";

describe("Realtime event handling", () => {
  it("extracts transcript deltas and failures", () => {
    expect(transcriptDelta({ type: "response.output_audio_transcript.delta", delta: "Hello" })).toBe("Hello");
    expect(inputTranscriptDelta({ type: "conversation.item.input_audio_transcription.delta", delta: "I got it" })).toBe("I got it");
    expect(completedTranscript({ type: "conversation.item.input_audio_transcription.completed", transcript: "I got it." }, "input")).toBe("I got it.");
    expect(completedTranscript({ type: "response.output_audio_transcript.done", transcript: "Nice!" }, "output")).toBe("Nice!");
    expect(realtimeErrorMessage({ type: "error", error: { message: "Disconnected" } })).toBe("Disconnected");
  });
});
