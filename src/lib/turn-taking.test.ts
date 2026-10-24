import { describe, expect, it } from "vitest";
import {
  TalkOverController,
  isBackchannel,
  isStopIntent,
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

function start(controller: TalkOverController, nowMs = 0) {
  return controller.update(snapshot({ nowMs, userSpeechActive: true }));
}

describe("TalkOverController", () => {
  it("recognizes only genuinely short backchannels", () => {
    expect(isBackchannel("yeah")).toBe(true);
    expect(isBackchannel("mm-hm")).toBe(true);
    expect(isBackchannel("uh-huh")).toBe(true);
    expect(isBackchannel("Yeah, okay")).toBe(true);
    expect(isBackchannel("yeah, but that is not what I meant")).toBe(false);
    expect(isBackchannel("no")).toBe(false);
    expect(isBackchannel("thanks!")).toBe(true);
  });

  it("does not cut the assistant for a short acknowledgement", () => {
    const controller = new TalkOverController({ backchannelSafetyMs: 2_000 });

    start(controller);
    const duringSpeech = controller.update(snapshot({
      nowMs: 350,
      userSpeechActive: true,
      userTranscript: "yeah",
    }));
    expect(duringSpeech).toMatchObject({ handoff: false, reason: "backchannel" });

    const afterPause = controller.update(snapshot({
      nowMs: 700,
      userSpeechActive: false,
      userTranscript: "yeah",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(afterPause).toMatchObject({ handoff: false, reason: "backchannel" });
  });

  it("does not fire a latent safety handoff after a completed quiet backchannel", () => {
    const controller = new TalkOverController({ backchannelSafetyMs: 1_000 });
    start(controller);
    controller.update(snapshot({
      nowMs: 250,
      userSpeechActive: true,
      userTranscript: "yeah",
    }));
    const quietAck = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: false,
      userTranscript: "yeah",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(quietAck).toMatchObject({ handoff: false, reason: "backchannel" });
    expect(quietAck.nextCheckAt).toBeUndefined();

    const muchLater = controller.update(snapshot({
      nowMs: 8_500,
      userSpeechActive: false,
      userTranscript: "yeah",
      userTranscriptComplete: true,
      assistantGenerating: false,
      assistantAudioPlaying: true,
    }));
    expect(muchLater).toMatchObject({ handoff: false, reason: "backchannel" });
    expect(muchLater.nextCheckAt).toBeUndefined();
  });

  it("keeps a noisy VAD start alive until there is a transcript or bounded safety", () => {
    const controller = new TalkOverController({ backchannelSafetyMs: 2_000 });
    start(controller);

    const noisy = controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: true,
      inputLevel: 0.12,
    }));
    expect(noisy.handoff).toBe(false);
    expect(noisy.reason).toBe("awaiting_transcript");

    const stillNoisy = controller.update(snapshot({
      nowMs: 1_999,
      userSpeechActive: true,
      inputLevel: 0.12,
    }));
    expect(stillNoisy.handoff).toBe(false);

    const safety = controller.update(snapshot({
      nowMs: 2_000,
      userSpeechActive: true,
      inputLevel: 0.12,
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff" });
  });

  it("bounds a committed but untranslated quiet input instead of waiting forever", () => {
    const controller = new TalkOverController();
    start(controller);

    const stopped = controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));
    expect(stopped).toMatchObject({
      handoff: false,
      reason: "awaiting_transcript",
      nextCheckAt: 4_200,
    });

    const safety = controller.update(snapshot({
      nowMs: 4_200,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("keeps a 150-600 ms unknown acknowledgement protected even during a gap", () => {
    const controller = new TalkOverController();
    start(controller);

    const quietBlip = controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputQuiet: true,
      outputBoundary: "phrase",
    }));
    expect(quietBlip).toMatchObject({
      handoff: false,
      reason: "awaiting_transcript",
      nextCheckAt: 4_200,
    });
  });

  it.each([
    ["a measured output gap", { outputQuiet: true }, "output_quiet"],
    ["a phrase boundary", { outputBoundary: "phrase" as const }, "output_boundary"],
  ] as const)("hands off an unknown turn after sustained input at %s without ASR", (_label, signal, reason) => {
    const controller = new TalkOverController();
    start(controller);

    const beforeSustained = controller.update(snapshot({
      nowMs: 1_399,
      userSpeechActive: true,
      userInputCommitted: true,
    }));
    expect(beforeSustained).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const sustained = controller.update(snapshot({
      nowMs: 1_500,
      userSpeechActive: true,
      userInputCommitted: true,
      ...signal,
    }));
    expect(sustained).toMatchObject({
      handoff: true,
      reason,
      fadeMs: 140,
    });
  });

  it("does not accumulate separate short runs, then hands off after a genuinely sustained resumed run", () => {
    const controller = new TalkOverController();
    start(controller);

    // Two short runs add up to more than the threshold, but neither run is
    // sustained on its own. A pause/resume must not make the old response
    // disappear just because ASR is still missing.
    controller.update(snapshot({ nowMs: 600, userSpeechActive: true, userInputCommitted: true }));
    const paused = controller.update(snapshot({
      nowMs: 800,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputQuiet: true,
    }));
    expect(paused).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const resumed = controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: true,
      userInputCommitted: true,
      outputQuiet: true,
    }));
    expect(resumed).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const stillShort = controller.update(snapshot({
      nowMs: 2_000,
      userSpeechActive: true,
      userInputCommitted: true,
      outputQuiet: true,
    }));
    expect(stillShort).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const sustained = controller.update(snapshot({
      nowMs: 2_400,
      userSpeechActive: true,
      userInputCommitted: true,
      outputQuiet: true,
    }));
    expect(sustained).toMatchObject({ handoff: true, reason: "output_quiet", fadeMs: 140 });
  });

  it("uses a shorter finite fallback for sustained unknown speech when no safe signal arrives", () => {
    const controller = new TalkOverController();
    start(controller);

    const beforeFallback = controller.update(snapshot({
      nowMs: 2_199,
      userSpeechActive: true,
      userInputCommitted: true,
    }));
    expect(beforeFallback).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const fallback = controller.update(snapshot({
      nowMs: 2_200,
      userSpeechActive: true,
      userInputCommitted: true,
    }));
    expect(fallback).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("does not let an unknown input cut through output before its 4.2 s safety wall", () => {
    const controller = new TalkOverController();
    start(controller);

    // This is intentionally a short, completed-but-untranslated blip. The
    // faster sustained-input path must not treat it as a topic change.
    controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));

    const beforeSafety = controller.update(snapshot({
      nowMs: 4_199,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputBoundary: "sentence",
      outputQuiet: true,
    }));

    expect(beforeSafety).toMatchObject({
      handoff: false,
      reason: "awaiting_transcript",
      nextCheckAt: 4_200,
    });
  });

  it("uses a measured output gap or current phrase boundary at the unknown-input safety wall", () => {
    const quietController = new TalkOverController();
    start(quietController);
    const quiet = quietController.update(snapshot({
      nowMs: 4_200,
      userSpeechActive: true,
      outputQuiet: true,
    }));
    expect(quiet).toMatchObject({ handoff: true, reason: "output_quiet", fadeMs: 140 });

    const boundaryController = new TalkOverController();
    start(boundaryController);
    const boundary = boundaryController.update(snapshot({
      nowMs: 4_200,
      userSpeechActive: true,
      outputBoundary: "phrase",
    }));
    expect(boundary).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("waits for an upcoming unknown-input boundary only inside the fixed safety grace", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));

    const waiting = controller.update(snapshot({
      nowMs: 4_200,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputBoundaryAt: 5_600,
    }));
    expect(waiting).toMatchObject({
      handoff: false,
      reason: "awaiting_output_boundary",
      nextCheckAt: 5_600,
    });

    const boundary = controller.update(snapshot({
      nowMs: 5_600,
      userSpeechActive: true,
      outputBoundaryAt: 5_600,
    }));
    expect(boundary).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("falls back when an unknown-input timeline keeps moving beyond the fixed safety grace", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
    }));

    const firstWait = controller.update(snapshot({
      nowMs: 4_200,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputBoundaryAt: 5_600,
    }));
    expect(firstWait.handoff).toBe(false);

    const retimed = controller.update(snapshot({
      nowMs: 5_000,
      userSpeechActive: false,
      userPaused: true,
      userInputCommitted: true,
      outputBoundaryAt: 6_300,
    }));
    expect(retimed).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("does not trust a delayed VAD stop while the input meter is still hot", () => {
    const controller = new TalkOverController();
    start(controller);
    const substantive = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      inputLevel: 0.12,
      userTranscript: "Actually, that is not what I meant",
    }));
    expect(substantive.handoff).toBe(false);

    const delayedStop = controller.update(snapshot({
      nowMs: 700,
      userSpeechActive: false,
      inputLevel: 0.12,
      userTranscript: "Actually, that is not what I meant",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(delayedStop).toMatchObject({ handoff: false, reason: "awaiting_pause" });

    const quiet = controller.update(snapshot({
      nowMs: 850,
      userSpeechActive: false,
      inputLevel: 0,
      userTranscript: "Actually, that is not what I meant",
      userTranscriptComplete: true,
    }));
    expect(quiet).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const boundary = controller.update(snapshot({
      nowMs: 980,
      userSpeechActive: false,
      inputLevel: 0,
      userTranscript: "Actually, that is not what I meant",
      userTranscriptComplete: true,
      outputBoundary: "phrase",
    }));
    expect(boundary).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("hands off a substantive correction at a real pause", () => {
    const controller = new TalkOverController();
    start(controller);

    expect(controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: true,
      userTranscript: "Actually, I got the date wrong",
    }))).toMatchObject({ handoff: false, reason: "awaiting_pause" });

    const handoff = controller.update(snapshot({
      nowMs: 1_050,
      userSpeechActive: false,
      userTranscript: "Actually, I got the date wrong.",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(handoff).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const outputQuiet = controller.update(snapshot({
      nowMs: 1_180,
      userSpeechActive: false,
      userTranscript: "Actually, I got the date wrong.",
      userTranscriptComplete: true,
      userPaused: true,
      outputQuiet: true,
    }));
    expect(outputQuiet).toMatchObject({ handoff: true, reason: "output_quiet", fadeMs: 140 });
  });

  it("treats a casual topic change like a real turn, without correction keywords", () => {
    const controller = new TalkOverController();
    start(controller);

    const stillListening = controller.update(snapshot({
      nowMs: 520,
      userSpeechActive: true,
      userTranscript: "By the way, did you see the game last night",
      outputBoundary: "word",
    }));
    expect(stillListening).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const phraseHandoff = controller.update(snapshot({
      nowMs: 680,
      userSpeechActive: true,
      userTranscript: "By the way, did you see the game last night?",
      outputBoundary: "phrase",
    }));
    expect(phraseHandoff).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("bounds a topic change to a short fallback when no output boundary arrives", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "By the way, what are you doing this weekend",
    }));

    const beforeFallback = controller.update(snapshot({
      nowMs: 1_199,
      userSpeechActive: true,
      userTranscript: "By the way, what are you doing this weekend",
    }));
    expect(beforeFallback.handoff).toBe(false);

    const fallback = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: true,
      userTranscript: "By the way, what are you doing this weekend",
    }));
    expect(fallback).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("waits for a known upcoming sentence boundary instead of cutting at the safety wall", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 2_000,
    }));

    const pastSafetyWall = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 2_000,
    }));
    expect(pastSafetyWall).toMatchObject({
      handoff: false,
      reason: "awaiting_output_boundary",
      nextCheckAt: 2_000,
    });

    const boundaryReached = controller.update(snapshot({
      nowMs: 2_000,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 2_000,
    }));
    expect(boundaryReached).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("does not let a repeatedly retimed boundary slide the safety window forever", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 3_000,
    }));

    // The first boundary is close enough to the safety wall to await. A bad
    // timeline then keeps moving the boundary; the original safety+grace cap
    // must win rather than being recalculated from the new deadline forever.
    const firstWait = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 3_000,
    }));
    expect(firstWait).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const retimed = controller.update(snapshot({
      nowMs: 1_800,
      userSpeechActive: true,
      userTranscript: "By the way, tell me about the weather",
      outputBoundaryAt: 3_700,
    }));
    expect(retimed).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("treats committed audio with failed ASR as a turn-taking signal without inventing text", () => {
    const controller = new TalkOverController();
    start(controller);

    const waiting = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userInputCommitted: true,
      userTranscriptComplete: true,
    }));
    expect(waiting).toMatchObject({ handoff: false, reason: "awaiting_pause" });

    const safety = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: true,
      userInputCommitted: true,
      userTranscriptComplete: true,
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff" });
  });

  it("hands off promptly when a substantive turn arrives before assistant audio", () => {
    const controller = new TalkOverController();
    start(controller);
    const handoff = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "Actually, I meant the other appointment",
      assistantGenerating: true,
      assistantAudioPlaying: false,
    }));
    expect(handoff).toMatchObject({ handoff: true, reason: "output_quiet", fadeMs: 140 });
  });

  it("keeps the pause sticky only until the user genuinely resumes", () => {
    const controller = new TalkOverController();
    start(controller);
    controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: true,
      userTranscript: "No, I need to correct that",
    }));
    expect(controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: false,
      userTranscript: "No, I need to correct that",
      userTranscriptComplete: true,
      userPaused: true,
    }))).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const resumed = controller.update(snapshot({
      nowMs: 1_050,
      userSpeechActive: true,
      inputLevel: 0.2,
      userTranscript: "No, I need to correct that, and here is why",
    }));
    expect(resumed).toMatchObject({ handoff: false, reason: "awaiting_pause" });
  });

  it("still reaches the bounded safety handoff after a quiet substantive pause", () => {
    const controller = new TalkOverController({ substantiveSafetyMs: 1_200 });
    start(controller);
    controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "No, I need to correct that",
    }));
    const paused = controller.update(snapshot({
      nowMs: 600,
      userSpeechActive: false,
      userTranscript: "No, I need to correct that",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(paused).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const safety = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: false,
      userTranscript: "No, I need to correct that",
      userTranscriptComplete: true,
      userPaused: true,
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("waits through a VAD stop when the transcript is delayed, then hands off once it arrives", () => {
    const controller = new TalkOverController();
    start(controller);

    const stopBeforeTranscript = controller.update(snapshot({
      nowMs: 650,
      userSpeechActive: false,
      userPaused: true,
    }));
    expect(stopBeforeTranscript).toMatchObject({ handoff: false, reason: "awaiting_transcript" });

    const completedLater = controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: false,
      userTranscript: "No, I meant the other one.",
      userTranscriptComplete: true,
    }));
    expect(completedLater).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });

    const completedAtQuiet = controller.update(snapshot({
      nowMs: 1_050,
      userSpeechActive: false,
      userTranscript: "No, I meant the other one.",
      userTranscriptComplete: true,
      outputQuiet: true,
    }));
    expect(completedAtQuiet).toMatchObject({ handoff: true, reason: "output_quiet" });
  });

  it("uses a completed assistant phrase boundary when the user is still speaking", () => {
    const controller = new TalkOverController();
    start(controller);

    const boundary = controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: true,
      userTranscript: "Wait, I need to correct that",
      outputBoundary: "phrase",
    }));
    expect(boundary).toMatchObject({ handoff: true, reason: "output_boundary", fadeMs: 140 });
  });

  it("detects only explicit stop or hold language as an urgent intent", () => {
    expect(isStopIntent("stop")).toBe(true);
    expect(isStopIntent("Hold on, I need to think")).toBe(true);
    expect(isStopIntent("wait a second")).toBe(true);
    expect(isStopIntent("No, that is not what I meant")).toBe(false);
    expect(isStopIntent("Actually, the date is wrong")).toBe(false);

    const controller = new TalkOverController();
    start(controller);
    const urgent = controller.update(snapshot({
      nowMs: 150,
      userSpeechActive: true,
      userTranscript: "hold on",
    }));
    expect(urgent).toMatchObject({ handoff: true, reason: "stop_intent", fadeMs: 140 });
  });

  it("does not treat a random word boundary as a natural handoff", () => {
    const controller = new TalkOverController({ substantiveSafetyMs: 2_000 });
    start(controller);

    const word = controller.update(snapshot({
      nowMs: 800,
      userSpeechActive: true,
      userTranscript: "No, stop, that is wrong",
      outputBoundary: "word",
    }));
    expect(word).toMatchObject({ handoff: false, reason: "awaiting_output_boundary" });
  });

  it("has a finite safety handoff even when substantive speech never pauses", () => {
    const controller = new TalkOverController({ substantiveSafetyMs: 1_500 });
    start(controller);
    controller.update(snapshot({
      nowMs: 300,
      userSpeechActive: true,
      userTranscript: "I need to tell you something important",
    }));

    const safety = controller.update(snapshot({
      nowMs: 1_500,
      userSpeechActive: true,
      userTranscript: "I need to tell you something important",
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff", fadeMs: 180 });
  });

  it("keeps applying the policy when generation is done but audio is still playing", () => {
    const controller = new TalkOverController({ substantiveSafetyMs: 1_200 });
    start(controller);

    const waiting = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: true,
      userTranscript: "Actually, please listen to this correction",
      assistantGenerating: false,
      assistantAudioPlaying: true,
    }));
    expect(waiting.handoff).toBe(false);

    const safety = controller.update(snapshot({
      nowMs: 1_200,
      userSpeechActive: true,
      userTranscript: "Actually, please listen to this correction",
      assistantGenerating: false,
      assistantAudioPlaying: true,
    }));
    expect(safety).toMatchObject({ handoff: true, reason: "safety_handoff" });
  });

  it("emits one handoff at most for repeated boundaries", () => {
    const controller = new TalkOverController();
    start(controller);
    const first = controller.update(snapshot({
      nowMs: 700,
      userSpeechActive: true,
      userTranscript: "No, that correction matters",
      outputBoundary: "sentence",
    }));
    expect(first.handoff).toBe(true);

    const repeated = controller.update(snapshot({
      nowMs: 720,
      userSpeechActive: true,
      userTranscript: "No, that correction matters",
      outputBoundary: "sentence",
    }));
    expect(repeated).toMatchObject({ handoff: false, reason: "already_handed_off" });
  });

  it("supports an explicit stop without requiring a user transcript", () => {
    const controller = new TalkOverController();
    start(controller);

    const stop = controller.update(snapshot({
      nowMs: 100,
      userSpeechActive: false,
      explicitStop: true,
    }));
    expect(stop).toMatchObject({ handoff: true, reason: "explicit_stop", fadeMs: 140 });
  });

  it("does not hand off when the assistant is not producing output", () => {
    const controller = new TalkOverController();
    const result = controller.update(snapshot({
      nowMs: 0,
      userSpeechActive: true,
      userTranscript: "No, I need to correct that",
      assistantGenerating: false,
      assistantAudioPlaying: false,
    }));
    expect(result).toMatchObject({ handoff: false, reason: "assistant_inactive" });
  });

  it("cleans up pending state on reset and permits a fresh overlap", () => {
    const controller = new TalkOverController({ substantiveSafetyMs: 1_000 });
    start(controller);
    controller.update(snapshot({
      nowMs: 900,
      userSpeechActive: true,
      userTranscript: "No, that is wrong",
      outputBoundary: "phrase",
    }));
    expect(controller.pending).toBe(true);

    controller.reset();
    expect(controller.pending).toBe(false);
    const fresh = start(controller, 2_000);
    expect(fresh).toMatchObject({ handoff: false, reason: "awaiting_transcript" });
  });

  it("does not create a stale cancellation when playback ends naturally", () => {
    const controller = new TalkOverController();
    start(controller);
    const ended = controller.update(snapshot({
      nowMs: 500,
      userSpeechActive: false,
      userTranscript: "yeah",
      userTranscriptComplete: true,
      assistantGenerating: false,
      assistantAudioPlaying: false,
    }));
    expect(ended).toMatchObject({ handoff: false, reason: "assistant_inactive" });
    expect(controller.pending).toBe(false);
  });
});
