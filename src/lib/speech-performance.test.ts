import { describe, expect, it } from "vitest";
import { renderAvatarExpression } from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import { SpeechPerformance, speakingPortraits, smileEyePath, type FacePerformanceInput } from "./speech-performance";
import type { ReactionCue } from "./reaction-cues";

const speaking: FacePerformanceInput = {
  expression: "neutral", phase: "speaking", activity: { input: 0, output: 0 },
};

function speechCue(overrides: Partial<ReactionCue> = {}): ReactionCue {
  return {
    id: "speech-acting-cue",
    turnId: "speech-acting-turn",
    source: "assistant",
    expression: "neutral",
    intensity: 0.95,
    effect: "none",
    confidence: 0.95,
    kind: "speech",
    gesture: "still",
    accent: "none",
    ...overrides,
  };
}

function eyeSignature(frame: ReturnType<SpeechPerformance["sample"]>): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, frame.expression, undefined, frame.openness);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

describe("speech-driven facial performance", () => {
  it("keeps the eyes open at rest, using the renderer's openness convention", () => {
    const frame = new SpeechPerformance().sample(speaking, 0);
    expect(frame.openness).toBe(1);
    expect(renderAvatarExpression(performanceAvatarDefinition, frame.expression, undefined, frame.openness))
      .toEqual(renderAvatarExpression(performanceAvatarDefinition, speakingPortraits.neutral));
  });

  it("does not invent talking or wandering when the output is silent", () => {
    const controller = new SpeechPerformance();
    const start = controller.sample(speaking, 0);
    for (let t = 16; t <= 3200; t += 16) {
      const frame = controller.sample(speaking, t);
      expect(frame.expression).toEqual(start.expression);
      expect(frame.speech).toBe(0);
    }
  });

  it("opens the eye silhouette with audible syllables and relaxes during pauses", () => {
    const controller = new SpeechPerformance();
    const rest = controller.sample(speaking, 0);
    let voiced = rest;
    for (let t = 16; t <= 480; t += 16) {
      voiced = controller.sample({ ...speaking, activity: { input: 0, output: 0.55 } }, t);
    }
    expect(voiced.expression.heightLeft).toBeGreaterThan(rest.expression.heightLeft + 2);
    expect(voiced.expression.heightLeft).toBeLessThan(rest.expression.heightLeft + 14);
    expect(voiced.speech).toBeGreaterThan(0.7);
    let settled = voiced;
    for (let t = 496; t <= 1600; t += 16) settled = controller.sample(speaking, t);
    expect(settled.speech).toBeLessThan(0.001);
    expect(settled.expression.heightLeft).toBeCloseTo(rest.expression.heightLeft, 1);
    expect(settled.expression.headY).toBe(0);
  });

  it("does not confuse the user's microphone with the assistant's voice", () => {
    const controller = new SpeechPerformance();
    controller.sample(speaking, 0);
    const frame = controller.sample({ ...speaking, activity: { input: 1, output: 0 } }, 16);
    expect(frame.speech).toBe(0);
  });

  it("changes a reaction from the visible pose, including a rapid reversal", () => {
    const controller = new SpeechPerformance();
    const first = controller.sample(speaking, 0);
    const changed = controller.sample({ ...speaking, expression: "surprised" }, 0);
    expect(changed.expression).toEqual(first.expression);
    const midpoint = controller.sample({ ...speaking, expression: "surprised" }, 40);
    expect(midpoint.expression.widthLeft).toBeGreaterThan(first.expression.widthLeft);
    expect(midpoint.expression.widthLeft).toBeLessThan(speakingPortraits.surprised.widthLeft);
    const reversed = controller.sample({ ...speaking, expression: "sad" }, 40);
    expect(reversed.expression).toEqual(midpoint.expression);
  });

  it("preserves large distinct expression silhouettes", () => {
    expect(speakingPortraits.excited.heightLeft).toBeGreaterThan(85);
    expect(speakingPortraits.surprised.widthLeft).toBeGreaterThan(50);
    expect(speakingPortraits.curious.heightLeft / speakingPortraits.curious.heightRight).toBeGreaterThan(1.5);
    // Amused no longer starts as a permanently closed smile. The laugh beat
    // can compress it later, but its semantic resting face stays open.
    expect(speakingPortraits.amused.heightLeft).toBeGreaterThanOrEqual(60);
    expect(speakingPortraits.amused.heightLeft).toBeLessThan(90);
    expect(speakingPortraits.sad.leftAngle).toBeGreaterThan(20);
  });

  it("forms smiling curves instead of reusing round surprise eyes for joy", () => {
    const controller = new SpeechPerformance("joyful");
    const cue = speechCue({
      id: "joyful-speech-beat",
      turnId: "joyful-speech-turn",
      expression: "joyful",
    });
    const input = {
      ...speaking,
      expression: "joyful" as const,
      cue,
      activity: { input: 0, output: 0.8 },
    };
    let peak = 0;
    let tail = 0;
    for (let t = 0; t <= 2400; t += 16) {
      const frame = controller.sample(input, t);
      peak = Math.max(peak, frame.smile);
      if (t >= 2200) tail = Math.max(tail, frame.smile);
    }
    expect(peak).toBeGreaterThan(0.7);
    // The smile is a readable semantic beat, then returns toward the open
    // friendly portrait instead of becoming the permanent resting face.
    expect(tail).toBeLessThan(peak * 0.7);
    const path = "M-20 0L0 0L20 0L20 10L0 10L-20 10Z";
    expect(smileEyePath(path, 0)).toBe(path);
    // The center rises while thickness compresses: a crescent, not a blob.
    expect(smileEyePath(path, 1)).toContain("L0 -5.10");
  });

  it("has no one-frame jump when an emotional change interrupts active speech", () => {
    const controller = new SpeechPerformance();
    const loud = { ...speaking, activity: { input: 0, output: 0.8 } };
    controller.sample(loud, 0);
    for (let t = 16; t < 480; t += 16) controller.sample(loud, t);
    const before = controller.sample(loud, 480);
    const after = controller.sample({ ...loud, expression: "sad" }, 480);
    expect(after.expression).toEqual(before.expression);
    expect(after.speech).toEqual(before.speech);
  });

  it("reduces speech motion without snapping mood transitions or forcing a blink", () => {
    const controller = new SpeechPerformance();
    controller.sample({ ...speaking, reducedMotion: true }, 0);
    const next = controller.sample({ ...speaking, reducedMotion: true, expression: "curious" }, 32);
    expect(next.openness).toBe(1);
    expect(next.expression.heightLeft).toBeGreaterThan(speakingPortraits.neutral.heightLeft);
    expect(next.expression.heightLeft).toBeLessThan(speakingPortraits.curious.heightLeft);
  });

  it("uses audio-gated phrase and word ticks to stage repeated finite acting beats", () => {
    // Keep the semantic cue's authored head gesture visible while word/phrase
    // ticks retarget the eyes. This prevents a 200–240ms timestamp stream from
    // repeatedly resetting a readable head beat back to neutral.
    const cue = speechCue({ gesture: "tilt-left" });
    const performer = new SpeechPerformance();
    const frameAt = (time: number, wordTick: number, phraseTick: number, punctuation: FacePerformanceInput["activity"]["punctuation"] = "none") => performer.sample({
      phase: "speaking",
      expression: "neutral",
      cue,
      activity: { input: 0, output: 0.8, wordTick, phraseTick, punctuation },
    }, time);

    frameAt(0, 0, 0, "sentence");
    const first = frameAt(320, 0, 0);
    const second = frameAt(620, 1, 0);
    const third = frameAt(920, 2, 1, "question");

    expect(first.beat).toMatch(/phrase-0|word-0/iu);
    expect(new Set([eyeSignature(first), eyeSignature(second), eyeSignature(third)]).size).toBeGreaterThanOrEqual(2);
    expect(Math.abs(first.expression.headX) + Math.abs(first.expression.headZ)).toBeGreaterThan(0.2);
    expect(Math.abs(second.expression.headX) + Math.abs(second.expression.headZ)).toBeGreaterThan(0.2);
    expect(Math.abs(third.expression.headX) + Math.abs(third.expression.headZ)).toBeGreaterThan(0.2);

    // A new tick rebases at the currently visible pose. The first frame of a
    // retarget is identical; the next one moves continuously toward the beat.
    const before = frameAt(1100, 2, 1);
    const sameTime = frameAt(1100, 3, 1);
    expect(sameTime.expression).toEqual(before.expression);
    expect(sameTime.body).toEqual(before.body);
    const next = frameAt(1116, 3, 1);
    expect(Math.max(
      Math.abs(next.expression.headX - sameTime.expression.headX),
      Math.abs(next.expression.headZ - sameTime.expression.headZ),
      Math.abs(next.body.x - sameTime.body.x),
    )).toBeLessThan(2.5);
  });

  it("carries an early user reaction into voice onset without restarting it", () => {
    const cue: ReactionCue = {
      id: "user-handoff-cue",
      turnId: "user-handoff-turn",
      source: "user",
      expression: "delighted",
      intensity: 0.9,
      effect: "none",
      confidence: 0.95,
    };
    const performer = new SpeechPerformance();
    const thinking = {
      phase: "thinking" as const,
      expression: "delighted" as const,
      cue,
      activity: { input: 0, output: 0 },
    };
    for (let time = 0; time <= 304; time += 16) performer.sample(thinking, time);
    const beforeVoice = performer.sample(thinking, 304);
    const voiceOnset = performer.sample({
      ...thinking,
      phase: "speaking",
      activity: { input: 0, output: 0.8 },
    }, 304);

    expect(voiceOnset.expression).toEqual(beforeVoice.expression);
    expect(voiceOnset.body).toEqual(beforeVoice.body);
    expect(voiceOnset.smile).toBe(beforeVoice.smile);

    const nextVoiceFrame = performer.sample({
      ...thinking,
      phase: "speaking",
      activity: { input: 0, output: 0.8 },
    }, 320);
    expect(Math.abs(nextVoiceFrame.expression.headZ - voiceOnset.expression.headZ)).toBeLessThan(2.5);
    expect(Math.abs(nextVoiceFrame.body.x - voiceOnset.body.x)).toBeLessThan(2.5);
  });

  it("lets a realistic fast word clock build to a real authored head beat", () => {
    const performer = new SpeechPerformance();
    const silhouettes = new Set<string>();
    let maxHeadTravel = 0;

    // Approximate audible word timestamps: one tick every 240ms and a new
    // phrase about every 1.2s. There is no semantic cue here, so the authored
    // phrase/word director must still reach a readable peak rather than being
    // regenerated from zero on every frame.
    for (let time = 0; time <= 5000; time += 16) {
      const frame = performer.sample({
        phase: "speaking",
        expression: "neutral",
        activity: {
          input: 0,
          output: 0.8,
          wordTick: Math.floor(time / 240),
          phraseTick: Math.floor(Math.max(0, time - 720) / 1200),
          punctuation: time >= 3600 ? "exclamation" : "none",
        },
      }, time);
      silhouettes.add(eyeSignature(frame));
      maxHeadTravel = Math.max(
        maxHeadTravel,
        Math.abs(frame.expression.headX),
        Math.abs(frame.expression.headZ),
      );
    }

    expect(maxHeadTravel).toBeGreaterThan(12);
    expect(silhouettes.size).toBeGreaterThan(5);
  });

  it("keeps a long spoken thought from cycling through the same tiny beat loop", () => {
    const performer = new SpeechPerformance();
    const beatSignatures: string[] = [];
    let previousBeat = "";

    for (let time = 0; time <= 9000; time += 16) {
      const frame = performer.sample({
        phase: "speaking",
        expression: "neutral",
        activity: {
          input: 0,
          output: 0.8,
          wordTick: Math.floor(time / 240),
          phraseTick: Math.floor(Math.max(0, time - 720) / 1200),
          punctuation: "none",
        },
      }, time);
      if (/^(word|phrase)/iu.test(frame.beat) && frame.beat !== previousBeat) {
        beatSignatures.push(`${frame.gesture}|${frame.accent}|${eyeSignature(frame)}`);
      }
      previousBeat = frame.beat;
    }

    expect(beatSignatures.length).toBeGreaterThan(14);
    // The first and last halves of a long response should not be the same
    // five authored states copied forward indefinitely.
    expect(new Set(beatSignatures.slice(0, 10)).size).toBeGreaterThan(7);
    expect(new Set(beatSignatures.slice(-10)).size).toBeGreaterThan(7);
  });

  it("keeps an explicit speech head beat intact while fast words change the eyes", () => {
    const cue = speechCue({ expression: "concerned", gesture: "tilt-left" });
    const performer = new SpeechPerformance();
    const silhouettes = new Set<string>();
    let maxRoll = 0;

    for (let time = 0; time <= 2000; time += 16) {
      const frame = performer.sample({
        phase: "speaking",
        expression: "concerned",
        cue,
        activity: {
          input: 0,
          output: 0.8,
          wordTick: Math.floor(time / 240),
          phraseTick: Math.floor(Math.max(0, time - 720) / 1200),
          punctuation: "none",
        },
      }, time);
      silhouettes.add(eyeSignature(frame));
      maxRoll = Math.max(maxRoll, Math.abs(frame.expression.headZ));
    }

    // The explicit cue owns the body/head envelope; word ticks are allowed to
    // retarget the eyes without restarting the tilt at its first keyframe.
    expect(maxRoll).toBeGreaterThan(26);
    expect(silhouettes.size).toBeGreaterThan(5);

    let paused = performer.sample({
      phase: "idle",
      expression: "neutral",
      activity: { input: 0, output: 0 },
      cue: null,
    }, 2016);
    for (let time = 2032; time <= 4000; time += 16) {
      paused = performer.sample({
        phase: "idle",
        expression: "neutral",
        activity: { input: 0, output: 0 },
        cue: null,
      }, time);
    }
    expect(Math.abs(paused.expression.headZ)).toBeLessThan(0.2);
    expect(Math.abs(paused.body.x)).toBeLessThan(0.2);
    expect(Math.abs(paused.body.y)).toBeLessThan(0.2);
  });

  it("keeps playful eye rolls finite and tied to a cue rather than idle roaming", () => {
    const cue = speechCue({ expression: "playful", accent: "eye-roll", variant: "playful-left-focus" });
    const performer = new SpeechPerformance();
    const withoutRoll = new SpeechPerformance();
    const rollOffsets: number[] = [];
    for (let time = 0; time <= 1500; time += 16) {
      const input: FacePerformanceInput = {
        phase: "speaking",
        expression: "playful",
        cue,
        activity: { input: 0, output: 0.8 },
      };
      const frame = performer.sample(input, time);
      const plain = withoutRoll.sample({ ...input, cue: { ...cue, accent: "none" } }, time);
      rollOffsets.push(frame.expression.positionXLeft - plain.expression.positionXLeft);
      expect(Number.isFinite(frame.expression.positionXLeft)).toBe(true);
      expect(Number.isFinite(frame.expression.positionYLeft)).toBe(true);
    }
    expect(Math.max(...rollOffsets) - Math.min(...rollOffsets)).toBeGreaterThan(4);
    // Settle back to the chosen portrait, not a hard-coded world-space zero.
    expect(Math.abs(rollOffsets.at(-1)!)).toBeLessThan(1);
  });

  it("gives a quiet listener varied, finite look-arounds and returns smoothly to speech", () => {
    const performer = new SpeechPerformance();
    const idle: FacePerformanceInput = {
      phase: "listening",
      expression: "attentive",
      activity: { input: 0, output: 0 },
    };
    const beats = new Set<string>();
    const signatures = new Set<string>();
    let lateIdle = performer.sample(idle, 0);
    for (let time = 16; time <= 10000; time += 16) {
      lateIdle = performer.sample(idle, time);
      beats.add(lateIdle.beat);
      signatures.add(eyeSignature(lateIdle));
    }
    expect(beats.has("look-left")).toBe(true);
    expect(beats.has("look-up")).toBe(true);
    expect(signatures.size).toBeGreaterThan(3);

    const speakingFrame = performer.sample({
      phase: "speaking",
      expression: "neutral",
      activity: { input: 0, output: 0.8 },
    }, 10000);
    expect(speakingFrame.expression).toEqual(lateIdle.expression);
    const settled = performer.sample({
      phase: "speaking",
      expression: "neutral",
      activity: { input: 0, output: 0.8 },
    }, 10016);
    expect(Math.abs(settled.expression.headZ - speakingFrame.expression.headZ)).toBeLessThan(2.5);
  });
});
