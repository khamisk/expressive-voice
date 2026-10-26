import { describe, expect, it } from "vitest";
import { expressionFields, renderAvatarExpression, type Expression } from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import {
  CHARACTER_INTENTS,
  CHARACTER_VARIANTS,
  applyCharacterVariant,
  getCharacterVariant,
  variantsFor,
  type CharacterIntent,
} from "./character-variants";
import { SpeechPerformance, speakingPortraits, type FacePerformanceInput } from "./speech-performance";
import type { ReactionCue } from "./reaction-cues";
import type { AvatarExpression, SemanticExpression } from "../types";

type MeaningCue = ReactionCue & {
  intent?: CharacterIntent;
  variant?: string;
};

type MeaningFrame = ReturnType<SpeechPerformance["sample"]> & {
  intent?: string;
  variantId?: string;
};

const expressionFamilyCandidates = [
  "neutral",
  "curious",
  "delighted",
  "concerned",
  "surprised",
] as const satisfies readonly SemanticExpression[];

function cue(overrides: Partial<MeaningCue> = {}): MeaningCue {
  return {
    id: "meaning-cue",
    turnId: "meaning-turn",
    source: "assistant",
    expression: "neutral",
    intensity: 0.95,
    effect: "none",
    confidence: 0.95,
    kind: "speech",
    gesture: "still",
    accent: "none",
    ...overrides,
  } as MeaningCue;
}

function frameAt(
  performer: SpeechPerformance,
  reaction: MeaningCue,
  time: number,
  reducedMotion = false,
  activity: Partial<FacePerformanceInput["activity"]> = {},
): MeaningFrame {
  return performer.sample({
    phase: "speaking",
    expression: reaction.expression,
    cue: reaction,
    reducedMotion,
    activity: {
      input: 0,
      output: 0.82,
      wordTick: Math.floor(time / 240),
      phraseTick: Math.floor(Math.max(0, time - 720) / 1_200),
      punctuation: "none",
      ...activity,
    },
  }, time) as MeaningFrame;
}

function eyeSignature(frame: MeaningFrame): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, frame.expression, undefined, frame.openness);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

function expressionDistance(a: Expression, b: Expression): number {
  return Math.max(...expressionFields.map((field) => {
    const scale = field.includes("Angle") ? 90 : field === "perspective" ? 2 : 120;
    return Math.abs(a[field] - b[field]) / scale;
  }));
}

function variantId(frame: MeaningFrame): string {
  expect(frame.variantId).toEqual(expect.any(String));
  return frame.variantId!;
}

function familyWithAlternates(): SemanticExpression {
  const family = expressionFamilyCandidates.find((expression) => variantsFor(expression).length >= 2);
  expect(family).toBeDefined();
  return family!;
}

function firstIntentForVariant(variant: { intents: readonly CharacterIntent[] }): CharacterIntent | undefined {
  return variant.intents[0] ?? CHARACTER_INTENTS[0];
}

describe("meaning-directed character performance", () => {
  it("keeps the shared intent registry finite and every variant addressable", () => {
    expect(CHARACTER_INTENTS.length).toBeGreaterThan(0);
    expect(new Set(CHARACTER_INTENTS).size).toBe(CHARACTER_INTENTS.length);
    expect(CHARACTER_VARIANTS.length).toBeGreaterThan(0);

    for (const variant of CHARACTER_VARIANTS) {
      expect(getCharacterVariant(variant.id)).toEqual(variant);
      expect(variantsFor(variant.expression)).toContainEqual(variant);
      expect(variant.intents.length).toBeGreaterThan(0);
      expect(variant.intents.every((intent) => CHARACTER_INTENTS.includes(intent))).toBe(true);
    }
  });

  it("preserves explicit accents while real word and phrase ticks keep arriving", () => {
    const stableVariant = variantsFor("concerned", "comfort")[0];
    const run = (accent: MeaningCue["accent"]) => {
      const performer = new SpeechPerformance();
      const reaction = cue({
        id: `accent-${accent}`,
        turnId: `accent-${accent}`,
        expression: "concerned",
        intent: "comfort",
        variant: stableVariant.id,
        gesture: "tilt-left",
        accent,
      });
      const frames: MeaningFrame[] = [];
      for (let time = 0; time <= 2_000; time += 16) frames.push(frameAt(performer, reaction, time));
      // The cue accent now starts immediately and has finished its authored
      // envelope by 660ms. Inspect its visible hold as well as its settle,
      // rather than requiring a completed one-shot to remain active forever.
      return [384, 576, 912].map((time) => frames[time / 16]);
    };

    const softened = run("soften");
    const widened = run("widen");
    expect(softened.some((frame) => frame.accent === "soften")).toBe(true);
    expect(widened.some((frame) => frame.accent === "widen")).toBe(true);
    expect(softened.some((frame, index) => eyeSignature(frame) !== eyeSignature(widened[index]))).toBe(true);
    expect(softened.some((frame, index) => expressionDistance(frame.expression, widened[index].expression) > 0.04)).toBe(true);
  });

  it("keeps tick-driven variation inside the authored semantic family", () => {
    const expression = familyWithAlternates();
    const allowed = new Set(variantsFor(expression).map((variant) => variant.id));
    const reaction = cue({ expression, id: "family-ticks", turnId: "family-ticks" });
    const performer = new SpeechPerformance();

    for (let time = 0; time <= 4_000; time += 16) {
      const frame = frameAt(performer, reaction, time);
      const chosen = getCharacterVariant(variantId(frame));
      expect(chosen).toBeDefined();
      expect(allowed.has(chosen!.id)).toBe(true);
      expect(chosen!.expression).toBe(expression);
    }
  });

  it("has at least four materially different hold poses for common intents", () => {
    const cases = [
      { expression: "concerned", intent: "comfort" },
      { expression: "amused", intent: "joke" },
      { expression: "curious", intent: "question" },
      { expression: "neutral", intent: "explain" },
    ] as const;

    for (const { expression, intent } of cases) {
      const eligible = variantsFor(expression, intent);
      expect(eligible.length, `${expression}/${intent} eligible variants`).toBeGreaterThanOrEqual(4);
      const rendered = eligible.map((variant) => {
        const applied = applyCharacterVariant(speakingPortraits[expression], variant);
        const scene = renderAvatarExpression(performanceAvatarDefinition, applied.expression, undefined, 1);
        return { expression: applied.expression, signature: `${scene.geometry.leftPath}|${scene.geometry.rightPath}` };
      });
      expect(new Set(rendered.map((pose) => pose.signature)).size, `${expression}/${intent} silhouettes`).toBeGreaterThanOrEqual(4);

      const materiallyDistinct = rendered.filter((pose, index) => rendered.some((other, otherIndex) => (
        index !== otherIndex && expressionDistance(pose.expression, other.expression) > 0.08
      )));
      expect(materiallyDistinct.length, `${expression}/${intent} material poses`).toBeGreaterThanOrEqual(4);
    }
  });

  it("uses recent meaning history to vary repeated turns without random family swaps", () => {
    const expression = familyWithAlternates();
    const eligible = variantsFor(expression);
    const performer = new SpeechPerformance();
    const selected: string[] = [];

    for (let index = 0; index < Math.min(4, eligible.length); index += 1) {
      const variant = eligible[index];
      const reaction = cue({
        id: `repeat-${index}`,
        turnId: `repeat-${index}`,
        expression,
        intent: firstIntentForVariant(variant),
      });
      selected.push(variantId(frameAt(performer, reaction, index * 1_800)));
    }

    expect(new Set(selected).size).toBeGreaterThan(1);
    expect(selected.every((id) => eligible.some((variant) => variant.id === id))).toBe(true);
  });

  it("starts a new semantic cue with its meaning, not a universal attentive prelude", () => {
    const expression = "surprised" as const;
    const reaction = cue({ expression, id: "first-surprise", turnId: "first-surprise" });
    const performer = new SpeechPerformance();
    let frame = frameAt(performer, reaction, 0);
    for (let time = 16; time <= 240; time += 16) frame = frameAt(performer, reaction, time);
    const chosen = getCharacterVariant(variantId(frame));

    expect(chosen).toBeDefined();
    expect(chosen!.expression).toBe(expression);
    expect(chosen!.expression).not.toBe("attentive");
    expect(frame.expression.widthLeft).toBeGreaterThan(44);
    expect(frame.expression.widthRight).toBeGreaterThan(44);
    expect(frame.expression.heightLeft).toBeGreaterThan(48);
    expect(frame.expression.heightRight).toBeGreaterThan(48);
    expect((frame as MeaningFrame).intent === undefined || typeof (frame as MeaningFrame).intent === "string").toBe(true);
  });

  it("renders forced variants as materially different silhouettes at a meaningful hold", () => {
    const expression = familyWithAlternates();
    const eligible = variantsFor(expression);
    let first = eligible[0];
    let second = eligible[1];
    let largestExpectedDistance = expressionDistance(
      applyCharacterVariant(speakingPortraits[expression], first).expression,
      applyCharacterVariant(speakingPortraits[expression], second).expression,
    );
    for (let left = 0; left < eligible.length; left += 1) {
      for (let right = left + 1; right < eligible.length; right += 1) {
        const distance = expressionDistance(
          applyCharacterVariant(speakingPortraits[expression], eligible[left]).expression,
          applyCharacterVariant(speakingPortraits[expression], eligible[right]).expression,
        );
        if (distance > largestExpectedDistance) {
          first = eligible[left];
          second = eligible[right];
          largestExpectedDistance = distance;
        }
      }
    }
    expect(largestExpectedDistance).toBeGreaterThan(0.08);
    const hold = (variant: typeof first) => {
      const reaction = cue({
        id: `forced-${variant.id}`,
        turnId: `forced-${variant.id}`,
        expression,
        variant: variant.id,
        intent: firstIntentForVariant(variant),
      });
      const performer = new SpeechPerformance();
      let frame = frameAt(performer, reaction, 0);
      for (let time = 16; time <= 1_000; time += 16) frame = frameAt(performer, reaction, time);
      expect(variantId(frame)).toBe(variant.id);
      return frame;
    };

    const firstFrame = hold(first);
    const secondFrame = hold(second);
    expect(eyeSignature(firstFrame)).not.toBe(eyeSignature(secondFrame));
    expect(expressionDistance(firstFrame.expression, secondFrame.expression)).toBeGreaterThan(0.08);
  });

  it("lets a ticked semantic cue hold its whole pose before changing, while its explicit eye accent stays primary", () => {
    const reaction = cue({
      id: "readable-hold",
      turnId: "readable-hold",
      expression: "neutral",
      intent: "explain",
      accent: "widen",
    });
    const performer = new SpeechPerformance();
    const variantChanges: number[] = [];
    let previousId: string | undefined;
    let lastAccentFrame: MeaningFrame | null = null;

    for (let time = 0; time <= 3_600; time += 16) {
      const frame = frameAt(performer, reaction, time);
      const chosenId = variantId(frame);
      if (previousId !== undefined && chosenId !== previousId) variantChanges.push(time);
      previousId = chosenId;
      if (time >= 480) {
        lastAccentFrame = frame;
        expect(frame.accent).toBe("widen");
      }
    }

    expect(variantChanges.length).toBeGreaterThanOrEqual(2);
    expect(variantChanges[0]).toBeGreaterThanOrEqual(350);
    for (let index = 1; index < variantChanges.length; index += 1) {
      expect(variantChanges[index] - variantChanges[index - 1]).toBeGreaterThanOrEqual(350);
    }
    expect(lastAccentFrame).not.toBeNull();

    // Hold the same variant constant so this comparison isolates the authored
    // eye accent from the normal variant history/word-clock selection.
    const stableVariant = variantsFor("neutral", "explain")[0];
    const withWiden = cue({
      id: "accent-priority-widen",
      turnId: "accent-priority-widen",
      expression: "neutral",
      intent: "explain",
      variant: stableVariant.id,
      accent: "widen",
    });
    const withoutWiden = cue({
      id: "accent-priority-none",
      turnId: "accent-priority-none",
      expression: "neutral",
      intent: "explain",
      variant: stableVariant.id,
      accent: "none",
    });
    const runTo = (reactionToRun: MeaningCue): MeaningFrame => {
      const performerToRun = new SpeechPerformance();
      let frame = frameAt(performerToRun, reactionToRun, 0);
      for (let time = 16; time <= 384; time += 16) frame = frameAt(performerToRun, reactionToRun, time);
      return frame;
    };
    const widenedFrame = runTo(withWiden);
    const plainFrame = runTo(withoutWiden);
    expect(expressionDistance(widenedFrame.expression, plainFrame.expression)).toBeGreaterThan(0.04);
  });

  it("rebases rapid semantic reversals from the visible pose", () => {
    const performer = new SpeechPerformance();
    const first = cue({ expression: "concerned", id: "reversal-a", turnId: "reversal-a", gesture: "tilt-left" });
    const second = cue({ expression: "delighted", id: "reversal-b", turnId: "reversal-b", gesture: "tilt-right" });
    for (let time = 0; time <= 480; time += 16) frameAt(performer, first, time);
    const before = frameAt(performer, first, 480);
    const reversed = frameAt(performer, second, 480);
    const next = frameAt(performer, second, 496);

    expect(reversed.expression).toEqual(before.expression);
    expect(reversed.body).toEqual(before.body);
    expect(expressionDistance(next.expression, reversed.expression)).toBeLessThan(0.08);
    expect(Math.abs(next.body.x - reversed.body.x)).toBeLessThan(2.5);
  });

  it("does not emit effects for negative or vulnerable news", () => {
    for (const effect of ["heart", "confetti", "sparkle", "question", "idea"] as const) {
      const performer = new SpeechPerformance();
      const reaction = cue({
        id: `negative-${effect}`,
        turnId: `negative-${effect}`,
        source: "user",
        kind: "reaction",
        expression: "concerned",
        effect,
      });
      let frame = frameAt(performer, reaction, 0);
      for (let time = 16; time <= 1_600; time += 16) frame = frameAt(performer, reaction, time);
      expect(frame.effect).toBeNull();
    }
  });

  it("keeps variant meaning and geometry finite when motion is reduced", () => {
    const expression = familyWithAlternates();
    const reaction = cue({ expression, id: "reduced-meaning", turnId: "reduced-meaning" });
    const performer = new SpeechPerformance();
    for (let time = 0; time <= 1_200; time += 16) {
      const frame = frameAt(performer, reaction, time, true);
      for (const field of expressionFields) expect(Number.isFinite(frame.expression[field])).toBe(true);
      for (const value of Object.values(frame.body)) expect(Number.isFinite(value)).toBe(true);
      expect(getCharacterVariant(variantId(frame))).toBeDefined();
      expect(Math.abs(frame.expression.headZ)).toBeLessThanOrEqual(34);
    }
  });
});
