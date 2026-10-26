import { memo, useId, useMemo, useRef, useState } from "react";
import { renderAvatarExpression } from "../lib/face-renderer";
import { PerformanceAvatar } from "./PerformanceAvatar";
import { smileEyePath, type VoiceActivity } from "../lib/speech-performance";
import { expressionLabels, semanticExpressions } from "../lib/expressions";
import { CHARACTER_VARIANTS, getCharacterVariant, variantsFor, type CharacterVariant } from "../lib/character-variants";
import { performanceAvatarDefinition } from "../lib/performance-avatar";
import { sampleVariantStudy, variantStudyCue } from "../lib/character-gallery";
import type { SemanticExpression } from "../types";
import { REACTION_EFFECTS, type ReactionEffect } from "../lib/reaction-cues";

type PreviewEffect = Exclude<ReactionEffect, "none">;

export type GallerySelection = { id: string; revision: number };
export type GalleryEffectPreview = { id: string; kind: ReactionEffect; revision: number };

/**
 * Preview effects replay over the chosen face; they never replace or replay
 * its facial cue. The separate revision gives every button press a fresh
 * one-shot effect identity, including pressing None to clear the effect.
 */
export function nextGalleryEffectPreview(
  selection: GallerySelection,
  current: GalleryEffectPreview,
  effect: ReactionEffect,
): GalleryEffectPreview {
  const revision = current.revision + 1;
  return {
    id: `${selection.id}:effect:${revision}`,
    kind: effect,
    revision,
  };
}

const previewEffectLabels: Record<PreviewEffect, string> = {
  confetti: "Confetti",
  sparkle: "Sparkle",
  heart: "Friendly",
  question: "Question",
  idea: "Idea",
  pop: "Pop",
  laugh: "Laugh",
  anger: "Anger",
};

const VariantThumbnail = memo(function VariantThumbnail({ variant }: { variant: CharacterVariant }) {
  const clipId = `study-${useId().replaceAll(":", "")}`;
  const sample = useMemo(() => sampleVariantStudy(variant), [variant]);
  const scene = useMemo(() => renderAvatarExpression(performanceAvatarDefinition, { ...sample.expression, headZ: 0 }, undefined, sample.openness), [sample]);
  const transform = `translate(${sample.body.x} ${sample.body.y}) rotate(${sample.expression.headZ}) scale(${sample.body.scale * sample.body.squashX} ${sample.body.scale * sample.body.squashY})`;
  return (
    <svg className="face-svg" viewBox="-150 -150 300 300" aria-hidden="true" data-static-variant={variant.id}>
      <defs><clipPath id={clipId}><path d={scene.geometry.headPath} /></clipPath></defs>
      <g transform={transform}>
        <path d={scene.geometry.headPath} fill="#f4f5f1" />
        <g clipPath={`url(#${clipId})`} fill="#111316">
          <path d={smileEyePath(scene.geometry.leftPath, sample.smile)} stroke="#111316" strokeWidth="1.5" strokeLinejoin="round" />
          <path d={smileEyePath(scene.geometry.rightPath, sample.smile)} stroke="#111316" strokeWidth="1.5" strokeLinejoin="round" />
        </g>
      </g>
    </svg>
  );
});

export function ExpressionGallery() {
  const activityRef = useRef<VoiceActivity>({ input: 0, output: 0 });
  const [family, setFamily] = useState<SemanticExpression | "all">("all");
  const [selection, setSelection] = useState<GallerySelection>({ id: CHARACTER_VARIANTS[0].id, revision: 0 });
  const [effectPreview, setEffectPreview] = useState<GalleryEffectPreview>({
    id: `${CHARACTER_VARIANTS[0].id}:effect:0`,
    kind: "none",
    revision: 0,
  });
  const selected = getCharacterVariant(selection.id) ?? CHARACTER_VARIANTS[0];
  const cue = useMemo(() => variantStudyCue(selected, selection.revision), [selected, selection.revision]);
  const variants = family === "all" ? CHARACTER_VARIANTS : variantsFor(family);
  const select = (variant: CharacterVariant) => {
    setEffectPreview((current) => nextGalleryEffectPreview({ ...selection, id: variant.id }, current, "none"));
    setSelection((current) => ({ id: variant.id, revision: current.revision + 1 }));
  };
  const selectEffect = (effect: ReactionEffect) => {
    setEffectPreview((current) => nextGalleryEffectPreview(selection, current, effect));
  };

  return (
    <main className="expression-gallery">
      <header className="expression-gallery__header">
        <div><h1>Expression library</h1><p>{CHARACTER_VARIANTS.length} variations across {semanticExpressions.length} feelings</p></div>
        <div className="expression-gallery__links"><a href="/?studio=performance&motion=full">Watch with voice</a><a href="/">Back to conversation</a></div>
      </header>
      <div className="expression-gallery__workspace">
        <section className="expression-study" aria-label="Selected expression preview">
          <div className="expression-study__avatar">
            <PerformanceAvatar expression={selected.expression} phase="listening" activityRef={activityRef} cue={cue} effectPreview previewEffect={effectPreview} />
          </div>
          <div className="expression-study__details">
            <p className="expression-study__eyebrow">Silent expression study</p>
            <h2>{selected.label}</h2>
            <p className="expression-study__intent">{selected.intents.join(" · ")}</p>
            <button className="expression-study__replay" type="button" onClick={() => {
              setSelection((current) => ({ id: selected.id, revision: current.revision + 1 }));
              setEffectPreview((current) => nextGalleryEffectPreview(selection, current, current.kind));
            }}>Replay expression</button>
            <p className="expression-study__hint">One acting beat, then a natural settle. No microphone or voice generation.</p>
            <div className="expression-study__effects" aria-label="Reaction accents">
              <div className="expression-study__effects-heading">
                <span>Reaction accents</span>
                <span>one-shot</span>
              </div>
              <div className="expression-study__effect-grid">
                <button
                  className="expression-study__effect"
                  type="button"
                  data-effect-preview="none"
                  aria-pressed={effectPreview.kind === "none"}
                  onClick={() => selectEffect("none")}
                >None</button>
                {REACTION_EFFECTS.filter((effect): effect is PreviewEffect => effect !== "none").map((effect) => {
                  return (
                    <button
                      className="expression-study__effect"
                      type="button"
                      key={effect}
                      data-effect-preview={effect}
                      aria-pressed={effectPreview.kind === effect}
                      aria-label={`${previewEffectLabels[effect]} reaction`}
                      onClick={() => selectEffect(effect)}
                    >{previewEffectLabels[effect]}</button>
                  );
                })}
              </div>
              <p className="expression-study__effects-hint">Pick a moment to see the character punctuate the feeling.</p>
            </div>
          </div>
        </section>
        <section className="expression-gallery__collection" aria-label="Expression variations">
          <div className="expression-gallery__filter">
            <label htmlFor="expression-family">Feeling</label>
            <select id="expression-family" value={family} onChange={(event) => {
              const value = event.currentTarget.value as SemanticExpression | "all";
              setFamily(value);
              if (value !== "all" && selected.expression !== value) select(variantsFor(value)[0]);
            }}>
              <option value="all">All feelings</option>
              {semanticExpressions.map((expression) => <option value={expression} key={expression}>{expressionLabels[expression]}</option>)}
            </select>
            <span>{variants.length} variations</span>
          </div>
          <div className="expression-grid">
            {variants.map((variant) => (
              <button className="expression-card" type="button" key={variant.id} data-variant-card={variant.id} aria-pressed={selected.id === variant.id} onClick={() => select(variant)}>
              <div className="expression-card__avatar"><VariantThumbnail variant={variant} /></div>
                <span>{variant.label}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
