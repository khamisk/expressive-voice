import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient } from "./realtime";
import type { ReactionCue } from "./reaction-cues";
import { SpeechPerformance } from "./speech-performance";

type WireEvent = Record<string, unknown>;

type InternalLateClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  manualTurnDetection: boolean;
  processLocalInput: (rms: number, now: number) => void;
  handleMessage: (raw: string) => void;
  outputLevel: number;
  outputWasAudible: boolean;
  outputMeterActive: boolean;
  transcriptCanPlay: boolean;
  presentedAssistantTranscript: string;
};

describe("Realtime late ASR context", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient() {
    const sent: WireEvent[] = [];
    const cues: ReactionCue[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: () => undefined,
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onReactionCue: (cue) => cues.push(cue),
      onError: () => undefined,
    });
    const client = voice as unknown as InternalLateClient;
    client.channel = {
      readyState: "open",
      send: (raw) => sent.push(JSON.parse(raw) as WireEvent),
      close: () => undefined,
    };
    client.manualTurnDetection = true;
    return { client, sent, cues };
  }

  function at(client: InternalLateClient, rms: number, now: number): void {
    clock = now;
    vi.setSystemTime(now);
    client.processLocalInput(rms, now);
  }

  function advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(16, remaining);
      clock += step;
      vi.setSystemTime(clock);
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }

  function driveSpeech(client: InternalLateClient): void {
    at(client, 0, 0);
    for (let now = 16; now <= 160; now += 16) at(client, 0.03, now);
    for (let now = 176; now <= 896; now += 16) at(client, 0, now);
  }

  function voiceResponses(sent: WireEvent[]): WireEvent[] {
    return sent.filter((event) => event.type === "response.create" && event.response === undefined);
  }

  function startVoiceResponse(client: InternalLateClient, id: string, text: string): void {
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id } }));
    client.outputLevel = 0.12;
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: id }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: id,
      delta: text,
    }));
  }

  function completeUserTranscript(client: InternalLateClient, itemId: string, transcript: string): void {
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript,
    }));
  }

  function speechCues(cues: ReactionCue[]): ReactionCue[] {
    return cues.filter((cue) => cue.kind === "speech");
  }

  it("refines one still-current neutral fast beat when final ASR grounds its meaning", () => {
    const { client, sent, cues } = createClient();

    driveSpeech(client);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "late-item" }));
    expect(voiceResponses(sent)).toHaveLength(1);

    startVoiceResponse(client, "voice-late-context", "Oh, nice!");
    advance(16);
    expect(speechCues(cues)).toHaveLength(1);
    expect(speechCues(cues)[0]).toMatchObject({ expression: "neutral", intent: "explain" });

    completeUserTranscript(client, "late-item", "I finally got the job!");

    const spoken = speechCues(cues);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toMatchObject({
      expression: "delighted",
      intent: "celebrate",
      effect: "none",
      anchor: "Oh, nice!",
    });
    expect(spoken[1].id).not.toBe(spoken[0].id);

    // Verify the visible controller consumes the revision, not just the
    // callback/mood label. A reused id left the old neutral face latched.
    const performer = new SpeechPerformance();
    const input = (cue: ReactionCue) => ({
      phase: "speaking" as const, expression: cue.expression, cue,
      activity: { input: 0, output: 0.82, wordTick: 1, phraseTick: 0 },
    });
    let before = performer.sample(input(spoken[0]), 0);
    for (let time = 16; time <= 320; time += 16) before = performer.sample(input(spoken[0]), time);
    const revision = performer.sample(input(spoken[1]), 320);
    expect(revision.expression).toEqual(before.expression);
    expect(revision.body).toEqual(before.body);
    let after = revision;
    for (let time = 336; time <= 640; time += 16) after = performer.sample(input(spoken[1]), time);
    expect(after.variantId.startsWith("delighted-")).toBe(true);
    expect(after.expression.heightLeft).toBeGreaterThan(before.expression.heightLeft + 5);

    // A duplicate final event is idempotent and cannot replay the refinement.
    completeUserTranscript(client, "late-item", "I finally got the job!");
    expect(speechCues(cues)).toHaveLength(2);
  });

  it("does not rewind a past neutral beat after a later speech beat is current", () => {
    const { client, sent, cues } = createClient();

    driveSpeech(client);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "past-item" }));
    startVoiceResponse(client, "voice-past-context", "Oh, nice! What happens next?");
    advance(1_600);

    const beforeLateAsr = speechCues(cues);
    expect(beforeLateAsr.length).toBeGreaterThanOrEqual(2);
    expect(beforeLateAsr[0]).toMatchObject({ expression: "neutral", intent: "explain" });
    expect(beforeLateAsr.some((cue) => cue.expression === "curious")).toBe(true);

    completeUserTranscript(client, "past-item", "I finally got the job!");

    // The first phrase is no longer current; the grounded user context must
    // not add a third cue or rewind the later curious beat.
    expect(speechCues(cues)).toHaveLength(beforeLateAsr.length);
    expect(voiceResponses(sent)).toHaveLength(1);
  });

  it("does not replace an already-meaningful fast beat with late user context", () => {
    const { client, cues } = createClient();

    driveSpeech(client);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "meaningful-item" }));
    startVoiceResponse(client, "voice-meaningful-context", "What happens next?");
    advance(16);

    expect(speechCues(cues)).toHaveLength(1);
    expect(speechCues(cues)[0]).toMatchObject({ expression: "curious", intent: "question" });

    completeUserTranscript(client, "meaningful-item", "I finally got the job!");

    expect(speechCues(cues)).toHaveLength(1);
  });
});
