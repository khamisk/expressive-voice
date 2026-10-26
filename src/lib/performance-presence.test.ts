import { describe, expect, it } from "vitest";
import { renderAvatarExpression } from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import { SpeechPerformance, speakingPortraits, type FacePerformanceInput } from "./speech-performance";
import type { ReactionCue } from "./reaction-cues";

const baseActivity: FacePerformanceInput["activity"] = { input: 0, output: 0.82 };

function speechCue(overrides: Partial<ReactionCue> = {}): ReactionCue {
  return {
    id: "presence-cue",
    turnId: "presence-turn",
    source: "assistant",
    expression: "neutral",
    intensity: 0.92,
    effect: "none",
    confidence: 0.95,
    kind: "speech",
    gesture: "tilt-left",
    accent: "none",
    intent: "explain",
    ...overrides,
  };
}

function inputFor(cue: ReactionCue, activity: FacePerformanceInput["activity"]): FacePerformanceInput {
  return { phase: "speaking", expression: cue.expression, cue, activity };
}

function eyeSignature(frame: ReturnType<SpeechPerformance["sample"]>): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, frame.expression, undefined, frame.openness);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

function headTravel(frame: ReturnType<SpeechPerformance["sample"]>): number {
  return Math.abs(frame.expression.headX) + Math.abs(frame.expression.headY) + Math.abs(frame.expression.headZ);
}

describe("speech performance presence contracts", () => {
  it("makes a new semantic face readable within 160ms without stacking entry tweens", () => {
    const cue = speechCue({
      id: "prompt-recognition", expression: "surprised", intent: "react",
      variant: "surprised-present", gesture: "still", accent: "none",
    });
    const performer = new SpeechPerformance();
    const first = performer.sample(inputFor(cue, baseActivity), 0);
    // The first frame inherits the current face rather than teleporting.
    expect(first.expression).toEqual(speakingPortraits.neutral);
    let frame = first;
    for (let time = 16; time <= 160; time += 16) frame = performer.sample(inputFor(cue, baseActivity), time);
    expect(frame.expression.widthLeft).toBeGreaterThan(49);
    expect(frame.expression.widthRight).toBeGreaterThan(49);
  });

  it("does not swap the base variant merely because one phrase lasts over two seconds", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({ id: "long-phrase", turnId: "long-phrase" });
    const variants = new Set<string>();

    for (let time = 0; time <= 2_400; time += 16) {
      const frame = performer.sample(inputFor(cue, {
        ...baseActivity,
        wordTick: Math.floor(time / 240),
        phraseTick: 0,
        punctuation: "none",
      }), time);
      variants.add(frame.variantId);
    }

    // Word timestamps should articulate the selected face; elapsed time alone
    // is not a semantic reason to replace its base silhouette.
    expect(variants.size).toBe(1);
  });

  it("keeps the first phrase tick on the variant chosen by the cue", () => {
    const cue = speechCue({ id: "first-phrase", turnId: "first-phrase" });
    const noTicks = new SpeechPerformance().sample(inputFor(cue, baseActivity), 0);
    const withTicks = new SpeechPerformance();
    withTicks.sample(inputFor(cue, baseActivity), 0);
    const firstPhraseTick = withTicks.sample(inputFor(cue, {
      ...baseActivity,
      wordTick: 0,
      phraseTick: 0,
      punctuation: "sentence",
    }), 16);

    expect(firstPhraseTick.variantId).toBe(noTicks.variantId);
  });

  it("allows a meaningful phrase boundary to select a different same-family variant", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({ id: "meaningful-phrases", turnId: "meaningful-phrases" });
    const first = performer.sample(inputFor(cue, {
      ...baseActivity,
      phraseTick: 0,
      punctuation: "sentence",
    }), 0);
    const second = performer.sample(inputFor(cue, {
      ...baseActivity,
      phraseTick: 1,
      punctuation: "sentence",
    }), 900);

    expect(second.variantId).not.toBe(first.variantId);
    expect(second.variantId.startsWith("neutral-")).toBe(true);
  });

  it("keeps the named variant stable while word articulation changes the eyes", () => {
    const cue = speechCue({
      id: "word-articulation",
      turnId: "word-articulation",
      variant: "neutral-present",
      gesture: "still",
    });
    const withTicks = new SpeechPerformance();
    const withoutTicks = new SpeechPerformance();
    const variants = new Set<string>();
    const signatures = new Set<string>();
    let tickDivergences = 0;

    for (let time = 0; time <= 1_200; time += 16) {
      const ticked = withTicks.sample(inputFor(cue, {
        ...baseActivity,
        wordTick: Math.floor(time / 240),
        phraseTick: 0,
        punctuation: "none",
      }), time);
      const plain = withoutTicks.sample(inputFor(cue, baseActivity), time);
      variants.add(ticked.variantId);
      signatures.add(eyeSignature(ticked));
      if (eyeSignature(ticked) !== eyeSignature(plain)) tickDivergences += 1;
    }

    expect(variants).toEqual(new Set(["neutral-present"]));
    expect(signatures.size).toBeGreaterThan(4);
    expect(tickDivergences).toBeGreaterThan(3);
  });

  it("rebases a cue reversal from the visible pose without a positional jump", () => {
    const performer = new SpeechPerformance();
    const firstCue = speechCue({ id: "reversal-before", turnId: "reversal", expression: "concerned", gesture: "tilt-left", accent: "soften" });
    const nextCue = speechCue({ id: "reversal-after", turnId: "reversal", expression: "curious", gesture: "tilt-right", accent: "widen" });
    for (let time = 0; time <= 480; time += 16) performer.sample(inputFor(firstCue, baseActivity), time);

    const before = performer.sample(inputFor(firstCue, baseActivity), 496);
    const after = performer.sample(inputFor(nextCue, baseActivity), 496);
    expect(after.expression).toEqual(before.expression);
    expect(after.body).toEqual(before.body);

    const nextFrame = performer.sample(inputFor(nextCue, baseActivity), 512);
    expect(Math.max(
      Math.abs(nextFrame.expression.headX - after.expression.headX),
      Math.abs(nextFrame.expression.headY - after.expression.headY),
      Math.abs(nextFrame.expression.headZ - after.expression.headZ),
      Math.abs(nextFrame.body.x - after.body.x),
      Math.abs(nextFrame.body.y - after.body.y),
    )).toBeLessThan(4);
  });

  it("reaches comparable physical progress by 320ms with or without word ticks", () => {
    const cue = speechCue({
      id: "progress-parity",
      turnId: "progress-parity",
      variant: "neutral-right-focus",
      gesture: "tilt-right",
      accent: "soften",
    });
    const noTicksPerformer = new SpeechPerformance();
    const tickedPerformer = new SpeechPerformance();
    let noTicks = noTicksPerformer.sample(inputFor(cue, baseActivity), 0);
    let ticked = tickedPerformer.sample(inputFor(cue, { ...baseActivity, wordTick: 0, phraseTick: 0 }), 0);
    for (let time = 16; time <= 320; time += 16) {
      noTicks = noTicksPerformer.sample(inputFor(cue, baseActivity), time);
      ticked = tickedPerformer.sample(inputFor(cue, {
        ...baseActivity,
        wordTick: Math.floor(time / 240),
        phraseTick: 0,
      }), time);
    }

    // Eye accents are allowed to differ. Compare only the authored physical
    // head/body track, which should not be held in anticipation by word ticks.
    expect(Math.abs(noTicks.expression.headZ)).toBeGreaterThan(8);
    expect(Math.abs(ticked.expression.headZ)).toBeGreaterThan(8);
    expect(Math.abs(ticked.expression.headZ - noTicks.expression.headZ)).toBeLessThan(5);
    expect(Math.abs(ticked.body.x - noTicks.body.x)).toBeLessThan(4);
    expect(Math.abs(ticked.body.y - noTicks.body.y)).toBeLessThan(4);
    expect(headTravel(ticked)).toBeGreaterThan(8);
  });
});
