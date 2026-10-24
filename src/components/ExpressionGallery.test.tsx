import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpressionGallery, nextGalleryEffectPreview } from "./ExpressionGallery";
import { CHARACTER_VARIANTS } from "../lib/character-variants";
import { semanticExpressions } from "../lib/expressions";
import { sampleVariantStudy, variantStudyCue } from "../lib/character-gallery";
import { REACTION_EFFECTS } from "../lib/reaction-cues";

// Structure and production-controller checks. These are not a visual review
// of the page, a browser interaction test, or a perceptual motion assessment.
describe("expression library", () => {
  it("offers every variant using native controls and only one live actor", () => {
    const markup = renderToStaticMarkup(<ExpressionGallery />);
    expect(markup.match(/data-variant-card=/gu)).toHaveLength(CHARACTER_VARIANTS.length);
    expect(markup.match(/data-static-variant=/gu)).toHaveLength(CHARACTER_VARIANTS.length);
    expect(markup.match(/data-performance="context-directed"/gu)).toHaveLength(1);
    expect(markup.match(/aria-pressed="true"/gu)).toHaveLength(2);
    expect(markup.match(/data-effect-preview=/gu)).toHaveLength(REACTION_EFFECTS.length);
    expect(markup.match(/<option /gu)).toHaveLength(semanticExpressions.length + 1);
    expect(markup).toContain('for="expression-family"');
    expect(markup).toContain("Replay expression");
    expect(markup).toContain("Silent expression study");
    expect(markup).toContain("Reaction accents");
    expect(markup).toContain('data-effect-preview="anger"');
    expect(markup).toContain('aria-label="Friendly reaction"');
    expect(markup).not.toContain("switches to");
    expect(markup).not.toContain("Heart reaction");
    expect(markup).not.toMatch(/data-eye-glint|data-cheek/);
    expect(markup).not.toMatch(/NaN|undefined/);
  });

  it("uses exact, finite local study cues with no effect or voice request", () => {
    for (const variant of CHARACTER_VARIANTS) {
      const first = variantStudyCue(variant, 0);
      const replay = variantStudyCue(variant, 1);
      expect(first).toMatchObject({ source: "user", kind: "reaction", variant: variant.id, expression: variant.expression, effect: "none" });
      expect(first.id).not.toBe(replay.id);
      const sample = sampleVariantStudy(variant);
      expect(sample.variantId).toBe(variant.id);
      expect(sample.effect).toBeNull();
      expect(Number.isFinite(sample.expression.widthLeft)).toBe(true);
      expect(Number.isFinite(sample.expression.heightRight)).toBe(true);
    }
  });

  it("replays an effect without replacing the selected face", () => {
    const selection = { id: "neutral-07", revision: 4 };
    const first = nextGalleryEffectPreview(selection, { id: "neutral-07:effect:1", kind: "none", revision: 1 }, "heart");
    const second = nextGalleryEffectPreview(selection, first, "heart");
    expect(first).toMatchObject({ id: "neutral-07:effect:2", kind: "heart", revision: 2 });
    expect(second.id).not.toBe(first.id);
    expect(first.kind).toBe("heart");
    expect(selection).toEqual({ id: "neutral-07", revision: 4 });
  });
});
