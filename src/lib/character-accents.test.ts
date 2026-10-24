import { describe, expect, it } from "vitest";
import { applyCharacterAccent, speechAccentForTick, type CharacterAccent } from "./character-accents";
import { speakingPortraits } from "./speech-performance";
import type { AvatarExpression } from "../types";

function runLength(values: readonly CharacterAccent[]): number {
  let longest = 0;
  let current = 0;
  let previous: CharacterAccent | undefined;
  for (const value of values) {
    current = value === previous ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = value;
  }
  return longest;
}

function normalSequence(expression: AvatarExpression, context: string): CharacterAccent[] {
  return Array.from({ length: 20 }, (_, tick) => speechAccentForTick(expression, tick, "none", context));
}

describe("word accent variation", () => {
  it("does not cluster one articulation across a long sentence", () => {
    for (const expression of ["concerned", "amused", "curious", "neutral", "excited", "delighted", "angry", "relieved"] as const) {
      for (let turn = 0; turn < 20; turn += 1) {
        const context = `turn-${turn}:${expression}:variant-a:explain`;
        const accents = Array.from({ length: 100 }, (_, tick) => speechAccentForTick(expression, tick, "none", context));
        expect(runLength(accents), `${expression}/${turn}`).toBeLessThanOrEqual(2);
        expect(new Set(accents).size, `${expression}/${turn}`).toBeGreaterThan(3);
      }
    }
  });

  it("does not replace a run of duplicate hashes with one repeated alternate", () => {
    const accents = Array.from({ length: 20 }, (_, tick) => speechAccentForTick("excited", tick + 1, "none", "turn-a:cue-a:excited:react"));
    expect(runLength(accents)).toBeLessThanOrEqual(2);
    expect(speechAccentForTick("neutral", Number.NaN, "none", "safe")).toBeDefined();
  });

  it("keeps replay deterministic but changes short-turn phrasing with context", () => {
    const first = normalSequence("curious", "turn-a:cue-1:curious-open:question");
    const replay = normalSequence("curious", "turn-a:cue-1:curious-open:question");
    const nextTurn = normalSequence("curious", "turn-b:cue-2:curious-left-focus:question");

    expect(replay).toEqual(first);
    expect(nextTurn).not.toEqual(first);
  });

  it("keeps punctuation accents semantically safe", () => {
    expect(speechAccentForTick("concerned", 2, "exclamation", "bad-news")).not.toBe("spark");
    expect(speechAccentForTick("angry", 2, "exclamation", "bad-news")).not.toBe("spark");
    expect(speechAccentForTick("delighted", 2, "exclamation", "earned-win")).toBe("spark");
  });

  it("does not assign gaze tours, blinks, or eye rolls to arbitrary words", () => {
    const shapeAccents = new Set(["widen", "soften", "spark", "squint", "browless-wince"]);
    for (const expression of ["neutral", "concerned", "amused", "curious", "excited", "angry"] as const) {
      for (const punctuation of ["none", "comma", "sentence", "question", "exclamation"] as const) {
        for (let tick = 0; tick < 40; tick += 1) {
          expect(shapeAccents.has(speechAccentForTick(expression, tick, punctuation, "same-phrase"))).toBe(true);
        }
      }
    }
  });

  it("lets word articulation peak before the next word, then finish", () => {
    const base = speakingPortraits.neutral;
    const start = applyCharacterAccent(base, 0, "widen", 0, 0.3, "speech");
    const peak = applyCharacterAccent(base, 0, "widen", 80, 0.3, "speech");
    const tail = applyCharacterAccent(base, 0, "widen", 220, 0.3, "speech");
    const end = applyCharacterAccent(base, 0, "widen", 280, 0.3, "speech");

    expect(start.expression).toEqual(base);
    expect(peak.expression.heightLeft - base.heightLeft).toBeGreaterThan(4);
    expect(tail.expression.heightLeft).toBeLessThan(peak.expression.heightLeft);
    expect(end.expression).toEqual(base);
    expect(peak.expression.positionXLeft).toBe(base.positionXLeft);
    expect(peak.expression.headZ).toBe(base.headZ);
  });

  it("starts the semantic eye accent with the cue instead of hiding it for 140ms", () => {
    const base = speakingPortraits.curious;
    const entry = applyCharacterAccent(base, 0, "widen", 80, 1);
    expect(entry.expression.widthLeft - base.widthLeft).toBeGreaterThan(4);
  });
});
