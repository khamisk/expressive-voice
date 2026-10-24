import type { CharacterVariant } from "./character-variants";
import type { ReactionCue } from "./reaction-cues";
import { SpeechPerformance } from "./speech-performance";

/** A local, silent study. It never starts a voice session or calls the director. */
export function variantStudyCue(variant: CharacterVariant, revision = 0): ReactionCue {
  return {
    id: `gallery:${variant.id}:${revision}`,
    turnId: `gallery:${revision}`,
    kind: "reaction",
    source: "user",
    expression: variant.expression,
    intent: variant.intents[0] ?? "react",
    variant: variant.id,
    gesture: variant.gesture,
    accent: variant.accent,
    confidence: 1,
    intensity: 0.95,
    effect: "none",
  };
}

/**
 * Static cards use a held frame from the real actor, not a second drawing
 * system. No timers or animation loops are created per card. Only the selected
 * large preview owns a live frame loop.
 */
export function sampleVariantStudy(variant: CharacterVariant) {
  const actor = new SpeechPerformance("neutral");
  const input = {
    phase: "listening" as const,
    expression: variant.expression,
    activity: { input: 0, output: 0 },
    cue: variantStudyCue(variant),
  };
  const heldFrameMs = variant.entryMs + Math.min(240, variant.holdMs * 0.6) + 160;
  let sample = actor.sample(input, 0);
  for (let at = 16; at <= heldFrameMs; at += 16) sample = actor.sample(input, at);
  return sample;
}
