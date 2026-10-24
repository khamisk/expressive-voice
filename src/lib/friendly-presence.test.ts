import { describe, expect, it } from "vitest";
import { SpeechPerformance, speakingPortraits, type FacePerformanceInput } from "./speech-performance";
import type { ReactionCue } from "./reaction-cues";

function cue(overrides: Partial<ReactionCue> = {}): ReactionCue {
  return {
    id: "friendly-presence-cue",
    turnId: "friendly-presence-turn",
    source: "user",
    expression: "joyful",
    intensity: 0.9,
    effect: "none",
    confidence: 0.95,
    kind: "reaction",
    gesture: "still",
    accent: "none",
    ...overrides,
  };
}

function listening(expression: FacePerformanceInput["expression"], cueValue?: ReactionCue | null): FacePerformanceInput {
  return {
    phase: "listening",
    expression,
    cue: cueValue,
    activity: { input: 0, output: 0 },
  };
}

function speaking(expression: FacePerformanceInput["expression"], cueValue: ReactionCue, wordTick?: number): FacePerformanceInput {
  return {
    phase: "speaking",
    expression,
    cue: cueValue,
    activity: { input: 0, output: 0.8, wordTick, phraseTick: 0 },
  };
}

describe("friendly character presence", () => {
  it.each(["joyful", "amused", "relieved"] as const)("keeps ordinary %s listening open and friendly instead of holding a closed smile", (expression) => {
    const performer = new SpeechPerformance(expression);
    const smiles: number[] = [];
    let frame = performer.sample(listening(expression), 0);

    for (let time = 16; time <= 3200; time += 16) {
      frame = performer.sample(listening(expression), time);
      smiles.push(frame.smile);
      expect(frame.effect).toBeNull();
      expect(frame.expression.heightLeft).toBeGreaterThan(40);
      expect(frame.expression.heightRight).toBeGreaterThan(40);
    }

    expect(Math.max(...smiles)).toBeLessThan(0.35);
    expect(frame.smile).toBeLessThan(0.3);
    expect(frame.expression.heightLeft).toBeGreaterThanOrEqual(speakingPortraits[expression].heightLeft * 0.82);
    expect(frame.expression.heightRight).toBeGreaterThanOrEqual(speakingPortraits[expression].heightRight * 0.82);
  });

  it.each(["joyful", "amused", "relieved"] as const)("lets an earned %s moment peak, then return to the open semantic mood", (expression) => {
    const performer = new SpeechPerformance(expression);
    const moment = cue({ id: `earned-${expression}`, turnId: `earned-${expression}-turn`, expression });
    let peak = 0;
    let peakFrame = performer.sample(listening(expression, moment), 0);
    let reopened = peakFrame;

    for (let time = 16; time <= 3200; time += 16) {
      const frame = performer.sample(listening(expression, moment), time);
      if (frame.smile > peak) {
        peak = frame.smile;
        peakFrame = frame;
      }
      if (time >= 2400) reopened = frame;
    }

    expect(peak).toBeGreaterThan(0.45);
    expect(peakFrame.expression.heightLeft).toBeLessThan(speakingPortraits[expression].heightLeft * 1.2);
    expect(reopened.smile).toBeLessThan(0.35);
    expect(reopened.smile).toBeLessThan(peak * 0.7);
    expect(reopened.expression.heightLeft).toBeGreaterThan(speakingPortraits[expression].heightLeft * 0.82);
    expect(reopened.expression.heightRight).toBeGreaterThan(speakingPortraits[expression].heightRight * 0.82);
  });

  it("does not replay a joyful smile just because audio word ticks keep arriving", () => {
    const performer = new SpeechPerformance("joyful");
    const speechCue = cue({
      id: "spoken-joy",
      turnId: "spoken-joy-turn",
      source: "assistant",
      kind: "speech",
      expression: "joyful",
    });
    const tailSmiles: number[] = [];
    let peak = 0;

    for (let time = 0; time <= 3600; time += 16) {
      const frame = performer.sample(speaking("joyful", speechCue, Math.floor(time / 240)), time);
      peak = Math.max(peak, frame.smile);
      if (time >= 2200) tailSmiles.push(frame.smile);
    }

    expect(peak).toBeGreaterThan(0.45);
    expect(Math.max(...tailSmiles)).toBeLessThan(0.35);
  });

  it("lets gallery effects change without restarting the settled friendly face", () => {
    const performer = new SpeechPerformance("joyful");
    const moment = cue({ id: "preview-friendly-cue", turnId: "preview-friendly-turn" });
    const settledInput = listening("joyful", moment);
    let settled = performer.sample(settledInput, 0);
    for (let time = 16; time <= 2600; time += 16) {
      settled = performer.sample(settledInput, time);
    }

    const heart = performer.sample({
      ...settledInput,
      effectPreview: true,
      previewEffect: { id: "friendly-preview-1", kind: "heart" },
    }, 2600);
    expect(heart.effect?.id).toBe("friendly-preview-1");
    expect(Math.max(
      Math.abs(heart.expression.widthLeft - settled.expression.widthLeft),
      Math.abs(heart.expression.heightLeft - settled.expression.heightLeft),
      Math.abs(heart.expression.leftAngle - settled.expression.leftAngle),
      Math.abs(heart.expression.positionYLeft - settled.expression.positionYLeft),
      Math.abs(heart.expression.headZ - settled.expression.headZ),
    )).toBeLessThan(0.001);
    expect(heart.body).toEqual(settled.body);
    expect(heart.smile).toBeCloseTo(settled.smile, 6);

    const sparkle = performer.sample({
      ...settledInput,
      effectPreview: true,
      previewEffect: { id: "friendly-preview-2", kind: "sparkle" },
    }, 2600);
    expect(sparkle.effect?.id).toBe("friendly-preview-2");
    expect(Math.max(
      Math.abs(sparkle.expression.widthLeft - heart.expression.widthLeft),
      Math.abs(sparkle.expression.heightLeft - heart.expression.heightLeft),
      Math.abs(sparkle.expression.leftAngle - heart.expression.leftAngle),
      Math.abs(sparkle.expression.positionYLeft - heart.expression.positionYLeft),
      Math.abs(sparkle.expression.headZ - heart.expression.headZ),
    )).toBeLessThan(0.001);
    expect(sparkle.body).toEqual(heart.body);
    expect(sparkle.smile).toBeCloseTo(heart.smile, 6);

    let cleared = performer.sample({
      ...settledInput,
      effectPreview: true,
      previewEffect: { id: "friendly-preview-none", kind: "none" },
    }, 2616);
    for (let time = 2632; time <= 3000; time += 16) {
      cleared = performer.sample({
        ...settledInput,
        effectPreview: true,
        previewEffect: { id: "friendly-preview-none", kind: "none" },
      }, time);
    }
    expect(cleared.effect).toBeNull();
    expect(cleared.smile).toBeLessThan(0.35);
  });

  it("keeps the face continuous when a joyful moment arrives from the visible pose", () => {
    const performer = new SpeechPerformance("neutral");
    const before = performer.sample(listening("neutral"), 320);
    const reaction = cue({ id: "continuity-joy", turnId: "continuity-turn" });
    const sameTime = performer.sample(listening("joyful", reaction), 320);
    expect(sameTime.expression).toEqual(before.expression);
    expect(sameTime.body).toEqual(before.body);
    expect(sameTime.smile).toBe(before.smile);

    const next = performer.sample(listening("joyful", reaction), 336);
    expect(Math.abs(next.smile - sameTime.smile)).toBeLessThan(0.3);
    expect(Math.max(
      Math.abs(next.expression.headX - sameTime.expression.headX),
      Math.abs(next.expression.headZ - sameTime.expression.headZ),
      Math.abs(next.body.x - sameTime.body.x),
    )).toBeLessThan(2.5);
  });

  it("does not decorate concerned or sad moments with a friendly effect or smile", () => {
    for (const expression of ["concerned", "sad"] as const) {
      const performer = new SpeechPerformance(expression);
      const negative = cue({
        id: `negative-${expression}`,
        turnId: `negative-${expression}-turn`,
        expression,
        effect: expression === "sad" ? "heart" : "confetti",
        source: "user",
      });
      let maxSmile = 0;
      for (let time = 0; time <= 2200; time += 16) {
        const frame = performer.sample(listening(expression, negative), time);
        maxSmile = Math.max(maxSmile, frame.smile);
        expect(frame.effect).toBeNull();
      }
      expect(maxSmile).toBeLessThan(0.3);
    }
  });
});
