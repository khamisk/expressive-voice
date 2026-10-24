import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient } from "./realtime";
import {
  TalkOverController,
  type TalkOverDecision,
  type TalkOverSnapshot,
} from "./turn-taking";

function snapshot(overrides: Partial<TalkOverSnapshot> = {}): TalkOverSnapshot {
  return {
    nowMs: 0,
    userSpeechActive: false,
    assistantGenerating: true,
    assistantAudioPlaying: true,
    ...overrides,
  };
}

function start(controller: TalkOverController): TalkOverDecision {
  return controller.update(snapshot({ nowMs: 0, userSpeechActive: true }));
}

function atPhraseBoundary(
  controller: TalkOverController,
  transcript: string,
  nowMs = 680,
): TalkOverDecision {
  start(controller);
  controller.update(snapshot({
    nowMs: 500,
    userSpeechActive: true,
    userTranscript: transcript,
  }));
  return controller.update(snapshot({
    nowMs,
    userSpeechActive: true,
    userTranscript: transcript,
    outputBoundary: "phrase",
  }));
}

describe("talk-over phrase QA matrix", () => {
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

  function advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(16, remaining);
      clock += step;
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }

  function createRealtimeHarness() {
    const sent: Array<Record<string, unknown>> = [];
    const cues: unknown[] = [];
    const client = new RealtimeVoiceClient({
      onPhase: () => undefined,
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onReactionCue: (cue) => cues.push(cue),
      onError: () => undefined,
    }) as unknown as {
      channel: { readyState: string; send: (raw: string) => void; close: () => void };
      handleMessage: (raw: string) => void;
      checkTalkOver: (outputBoundary?: "word" | "phrase" | "sentence") => void;
      outputMeterActive: boolean;
      responseActive: boolean;
    };
    client.channel = {
      readyState: "open",
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      close: () => undefined,
    };
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-qa" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-qa" }));
    return { client, sent, cues };
  }

  it.each(["yeah", "mhm", "right"])(
    "keeps brief %s backchannels flowing instead of cutting the assistant",
    (phrase) => {
      const controller = new TalkOverController();
      start(controller);
      const speaking = controller.update(snapshot({
        nowMs: 500,
        userSpeechActive: true,
        userTranscript: phrase,
      }));
      const quiet = controller.update(snapshot({
        nowMs: 900,
        userSpeechActive: false,
        userPaused: true,
        userTranscript: phrase,
        userTranscriptComplete: true,
      }));
      const later = controller.update(snapshot({
        nowMs: 8_500,
        userSpeechActive: false,
        userPaused: true,
        userTranscript: phrase,
        userTranscriptComplete: true,
      }));

      expect(speaking).toMatchObject({ handoff: false, reason: "backchannel" });
      expect(quiet).toMatchObject({ handoff: false, reason: "backchannel" });
      expect(later).toMatchObject({ handoff: false, reason: "backchannel" });
      expect(later.nextCheckAt).toBeUndefined();
    },
  );

  it("recognizes a backchannel that turns into a real correction at the next phrase boundary", () => {
    const controller = new TalkOverController();
    start(controller);
    expect(controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "yeah, but actually, that is not what I meant",
    }))).toMatchObject({ handoff: false, reason: "awaiting_pause" });

    const handoff = controller.update(snapshot({
      nowMs: 680,
      userSpeechActive: true,
      userTranscript: "yeah, but actually, that is not what I meant",
      outputBoundary: "phrase",
    }));
    expect(handoff).toMatchObject({
      handoff: true,
      reason: "output_boundary",
      fadeMs: 140,
    });
  });

  it.each([
    ["Actually, I meant the other appointment", "correction"],
    ["No, that date is wrong", "direct correction"],
    ["By the way, did you see the game last night", "unrelated topic"],
  ] as const)("hands off %s at a natural phrase boundary (%s)", (phrase, _category) => {
    const controller = new TalkOverController();
    const handoff = atPhraseBoundary(controller, phrase);
    expect(handoff).toMatchObject({
      handoff: true,
      reason: "output_boundary",
      fadeMs: 140,
    });
  });

  it("does not confuse an interesting aside with an explicit stop request", () => {
    const controller = new TalkOverController();
    const handoff = atPhraseBoundary(controller, "wait, that's interesting");
    expect(handoff).toMatchObject({ handoff: true, reason: "output_boundary" });
  });

  it("lets an explicit wait request interrupt immediately", () => {
    const controller = new TalkOverController();
    start(controller);
    const handoff = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "wait a second",
    }));
    expect(handoff).toMatchObject({
      handoff: true,
      reason: "stop_intent",
      fadeMs: 140,
    });
  });

  it("uses the latest transcript when a second redirect arrives before the boundary", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "Tell me about the weekend",
    }));
    controller.update(snapshot({
      nowMs: 620,
      userSpeechActive: true,
      userTranscript: "Actually, make that tomorrow's weather",
    }));

    const handoff = controller.update(snapshot({
      nowMs: 760,
      userSpeechActive: true,
      userTranscript: "Actually, make that tomorrow's weather",
      outputBoundary: "phrase",
    }));
    expect(handoff).toMatchObject({ handoff: true, reason: "output_boundary" });

    // The controller emits one handoff for the latest overlap; a repeated
    // boundary cannot resurrect or replay the superseded first topic.
    expect(controller.update(snapshot({
      nowMs: 800,
      userSpeechActive: true,
      userTranscript: "Actually, make that tomorrow's weather",
      outputBoundary: "sentence",
    }))).toMatchObject({ handoff: false, reason: "already_handed_off" });
  });

  it("waits for delayed ASR, then uses a measured output gap once the correction is known", () => {
    const controller = new TalkOverController();
    start(controller);

    const beforeAsr = controller.update(snapshot({
      nowMs: 650,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));
    expect(beforeAsr).toMatchObject({ handoff: false, reason: "awaiting_transcript" });
    expect(beforeAsr.nextCheckAt).toBe(4_200);

    const knownCorrection = controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: false,
      userPaused: true,
      userTranscript: "No, I meant the other one.",
      userTranscriptComplete: true,
      userInputCommitted: true,
    }));
    expect(knownCorrection).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const handoff = controller.update(snapshot({
      nowMs: 1_050,
      userSpeechActive: false,
      userPaused: true,
      userTranscript: "No, I meant the other one.",
      userTranscriptComplete: true,
      userInputCommitted: true,
      outputQuiet: true,
    }));
    expect(handoff).toMatchObject({ handoff: true, reason: "output_quiet", fadeMs: 140 });
  });

  it("uses committed audio after failed ASR without treating the missing transcript as a reaction cue", () => {
    const controller = new TalkOverController();
    start(controller);

    const waiting = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: false,
      userPaused: true,
      userTranscriptComplete: true,
      userInputCommitted: true,
    }));
    expect(waiting).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const fallback = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: false,
      userPaused: true,
      userTranscriptComplete: true,
      userInputCommitted: true,
    }));
    expect(fallback).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
    // This pure controller receives no text from which a mood could be
    // invented. The transport's failed-ASR branch is separately responsible
    // for emitting the voice response without starting reaction analysis.
  });

  it.each(["yeah", "mhm", "right"])(
    "keeps a transport session flowing for a completed %s backchannel",
    (phrase) => {
      const { client, sent, cues } = createRealtimeHarness();
      client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "backchannel" }));
      client.handleMessage(JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "backchannel",
        transcript: phrase,
      }));
      client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "backchannel" }));

      advance(8_500);
      expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
      expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([]);
      expect(cues).toEqual([]);
    },
  );

  it.each([
    ["Actually, I meant the other appointment", "phrase boundary"],
    ["No, that date is wrong", "phrase boundary"],
    ["wait, that's interesting", "phrase boundary"],
    ["wait a second", "explicit stop"],
  ] as const)("hands off %s through the transport (%s)", (phrase, _handoffKind) => {
    const { client, sent } = createRealtimeHarness();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "substantive" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "substantive",
      transcript: phrase,
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "substantive" }));
    if (phrase !== "wait a second") client.checkTalkOver("phrase");

    advance(139);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(1);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-qa" },
    ]);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("keeps the newest of two rapid redirects as the one transport handoff", () => {
    const { client, sent } = createRealtimeHarness();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "redirect-one" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "redirect-one",
      delta: "Tell me about the weekend",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "redirect-two" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "redirect-two",
      transcript: "Actually, make that tomorrow's weather",
    }));
    advance(500);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "redirect-two" }));
    client.checkTalkOver("phrase");

    advance(140);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-qa" },
    ]);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("hands off committed audio after ASR never completes, without a reaction", () => {
    const { client, sent, cues } = createRealtimeHarness();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "delayed-asr" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "delayed-asr" }));

    advance(4_200);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(180);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-qa" },
    ]);
    expect(cues).toEqual([]);
  });

  it("hands off failed ASR after the short substantive guardrail, without guessing mood", () => {
    const { client, sent, cues } = createRealtimeHarness();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "failed-asr" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "failed-asr" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed-asr",
      error: { message: "No transcription" },
    }));

    advance(1_200);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(180);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-qa" },
    ]);
    expect(cues).toEqual([]);
  });
});
