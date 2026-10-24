import { describe, expect, it } from "vitest";
import { CHARACTER_VARIANTS, applyCharacterVariant, getCharacterVariant, variantsFor } from "./character-variants";
import { speakingPortraits } from "./speech-performance";

describe("meaningful variant eligibility", () => {
  it("does not use lifted recognition or big punctuating poses to comfort someone", () => {
    for (const expression of ["concerned", "sad"] as const) {
      for (const intent of ["comfort", "react", "reassure"] as const) {
        const eligible = variantsFor(expression, intent);
        expect(eligible.length).toBeGreaterThanOrEqual(4);
        expect(eligible.every(variant => variant.gesture !== "lift" && variant.gesture !== "nod")).toBe(true);
        expect(eligible.some(variant => variant.id.endsWith("soft-down"))).toBe(true);
      }
    }
  });

  it("actually filters neutral explanation and curious questioning by delivery intent", () => {
    const explanation = variantsFor("neutral", "explain").map(variant => variant.id);
    expect(explanation).toHaveLength(4);
    expect(explanation).not.toContain("neutral-open");
    expect(explanation).not.toContain("neutral-soft-down");

    const question = variantsFor("curious", "question").map(variant => variant.id);
    expect(question).toHaveLength(4);
    expect(question).toContain("curious-look-up");
    expect(question).not.toContain("curious-soft-down");
  });

  it("keeps surprise recognition broad and centered and celebrations energetic", () => {
    const surprise = variantsFor("surprised", "react");
    expect(surprise).toHaveLength(4);
    expect(surprise.every(variant => !variant.id.endsWith("left-focus") && !variant.id.endsWith("right-focus"))).toBe(true);
    const celebration = variantsFor("delighted", "celebrate");
    expect(celebration).toHaveLength(4);
    expect(celebration.some(variant => variant.gesture === "lift")).toBe(true);
    expect(celebration.every(variant => variant.gesture !== "settle")).toBe(true);
  });

  it("retains the complete named bank for authored and gallery overrides", () => {
    expect(CHARACTER_VARIANTS.length).toBe(152);
    for (const variant of CHARACTER_VARIANTS) {
      expect(variant.intents.length).toBeGreaterThan(0);
      expect(getCharacterVariant(variant.id)).toEqual(variant);
      expect(variantsFor(variant.expression)).toContainEqual(variant);
    }
  });

  it("preserves the inward empathy silhouette across every delivery variation", () => {
    for (const expression of ["concerned", "sad", "shy"] as const) {
      for (const variant of variantsFor(expression)) {
        const face = applyCharacterVariant(speakingPortraits[expression], variant).expression;
        expect(face.leftAngle, variant.id).toBeGreaterThanOrEqual(14);
        expect(face.rightAngle, variant.id).toBeLessThanOrEqual(-14);
      }
    }
  });

  it("blends the defining tilt from the visible base without an intensity-zero jump", () => {
    const base = speakingPortraits.neutral;
    for (const expression of ["concerned", "sad", "shy"] as const) {
      for (const variant of variantsFor(expression)) {
        expect(applyCharacterVariant(base, variant, 0).expression).toEqual(base);
        const justStarted = applyCharacterVariant(base, variant, 0.001).expression;
        expect(Math.abs(justStarted.leftAngle - base.leftAngle)).toBeLessThan(0.06);
        expect(Math.abs(justStarted.rightAngle - base.rightAngle)).toBeLessThan(0.06);
      }
    }
  });
});
