import type { Expression } from "./face-renderer";
import type { SemanticExpression } from "../types";
import { semanticExpressions } from "./expressions";
import type { CharacterGesture } from "./character-gestures";
import type { CharacterAccent } from "./character-accents";
import {
  CHARACTER_INTENTS,
  isCharacterIntent,
  type CharacterIntent,
} from "./character-intents";

export { CHARACTER_INTENTS, isCharacterIntent };
export type { CharacterIntent };

/** Eye-only deltas are applied to a semantic base portrait. Head movement is
 * intentionally selected by `gesture`; keeping these tracks separate lets a
 * word beat change the eyes without cancelling a meaningful head gesture. */
export type CharacterVariantPose = Partial<Record<
  | "widthLeft"
  | "widthRight"
  | "heightLeft"
  | "heightRight"
  | "spacing"
  | "positionXLeft"
  | "positionXRight"
  | "positionYLeft"
  | "positionYRight"
  | "leftAngle"
  | "rightAngle"
  | "perspective",
  number
>>;

export type CharacterVariant = {
  id: string;
  label: string;
  expression: SemanticExpression;
  intents: readonly CharacterIntent[];
  gesture: CharacterGesture;
  accent: CharacterAccent;
  pose: CharacterVariantPose;
  /** Added to the caller's semantic smile amount, then clamped. */
  smileDelta: number;
  entryMs: number;
  holdMs: number;
  tailMs: number;
};

type AccentProfile = "positive" | "tender" | "playful" | "curious" | "hostile" | "neutral";
type ProfileMap<T> = Readonly<Record<AccentProfile, T>>;

type VariantBlueprint = {
  key: string;
  label: string;
  gesture: CharacterGesture;
  accents: ProfileMap<CharacterAccent>;
  smiles: ProfileMap<number>;
  pose: CharacterVariantPose;
  entryMs: number;
  holdMs: number;
  tailMs: number;
};

const profileFor = (expression: SemanticExpression): AccentProfile => {
  if (["delighted", "joyful", "excited", "proud"].includes(expression)) return "positive";
  if (["sad", "concerned", "shy", "relieved", "sleepy"].includes(expression)) return "tender";
  if (["playful", "amused"].includes(expression)) return "playful";
  if (["curious", "confused", "skeptical"].includes(expression)) return "curious";
  if (["angry", "frustrated", "determined"].includes(expression)) return "hostile";
  return "neutral";
};

const profiles = <T>(values: {
  positive: T;
  tender: T;
  playful: T;
  curious: T;
  hostile: T;
  neutral: T;
}): ProfileMap<T> => values;

// Delivery intent selects an appropriate set, not the entire bank. Previously
// every family intent was added to every blueprint: an apology could choose
// the same lifted, punctuating rhythm as a celebration. Keep several readable
// alternatives without making semantic selection a pose lottery.
const INTENT_BLUEPRINTS: Readonly<Record<CharacterIntent, readonly string[]>> = {
  acknowledge: ["present", "left-focus", "soft-down", "return"],
  react: ["present", "open", "look-up", "punctuate"],
  explain: ["present", "left-focus", "right-focus", "return"],
  consider: ["present", "left-focus", "right-focus", "look-up", "return"],
  question: ["present", "left-focus", "right-focus", "look-up"],
  comfort: ["present", "left-focus", "right-focus", "soft-down", "return"],
  reassure: ["present", "left-focus", "soft-down", "return"],
  celebrate: ["present", "open", "look-up", "punctuate"],
  emphasize: ["present", "open", "left-focus", "right-focus", "punctuate"],
  joke: ["present", "left-focus", "right-focus", "punctuate", "return"],
  correct: ["present", "left-focus", "right-focus", "punctuate", "return"],
  realize: ["present", "open", "look-up", "punctuate"],
};

function intentBlueprints(intent: CharacterIntent, profile: AccentProfile): readonly string[] {
  if (intent === "react" && profile === "tender") return INTENT_BLUEPRINTS.comfort;
  if (intent === "react" && profile === "playful") return INTENT_BLUEPRINTS.joke;
  return INTENT_BLUEPRINTS[intent];
}

/**
 * Shared rhythms are only the timing skeleton. These family-specific biases
 * give the same rhythm a different physical read: warmth opens and lifts,
 * empathy lowers and softens, curiosity breaks symmetry, and correction
 * carries a firmer angular counterweight. This keeps the bank genuinely
 * authored by meaning instead of claiming 152 variants from labels alone.
 */
const FAMILY_POSE_BIAS: ProfileMap<CharacterVariantPose> = profiles({
  positive: {
    widthLeft: 3, widthRight: 2, heightLeft: 5, heightRight: 3,
    positionYLeft: -2, positionYRight: -2, spacing: 2,
  },
  tender: {
    widthLeft: -1, widthRight: 0, heightLeft: -4, heightRight: -3,
    positionYLeft: 3, positionYRight: 3, leftAngle: 4, rightAngle: -4,
  },
  playful: {
    widthLeft: 4, widthRight: -2, heightLeft: 2, heightRight: -3,
    positionXLeft: -3, positionXRight: 4, leftAngle: -4, rightAngle: 5,
  },
  curious: {
    widthLeft: 2, widthRight: -1, heightLeft: 4, heightRight: -2,
    positionXLeft: 4, positionXRight: -4, positionYLeft: -2, positionYRight: 1,
    leftAngle: -4, rightAngle: 5,
  },
  hostile: {
    widthLeft: 2, widthRight: 3, heightLeft: 3, heightRight: 1,
    positionYLeft: -2, positionYRight: 1, leftAngle: -6, rightAngle: 6,
  },
  neutral: {
    widthLeft: 1, widthRight: 1, heightLeft: 2, heightRight: 1,
    positionYLeft: -1, positionYRight: -1,
  },
});

function mergePose(
  base: CharacterVariantPose,
  bias: CharacterVariantPose,
): CharacterVariantPose {
  const merged: CharacterVariantPose = { ...base };
  for (const [field, delta] of Object.entries(bias) as Array<[keyof CharacterVariantPose, number]>) {
    if (delta === undefined) continue;
    merged[field] = (merged[field] ?? 0) + delta;
  }
  return merged;
}

/**
 * Eight named acting rhythms. Each semantic expression receives all eight,
 * yielding 152 concrete variants while keeping the provider vocabulary small.
 * The geometry is deliberately asymmetric and exaggerated enough to read at
 * icon size; the selected gesture supplies the head rhythm and the accent
 * supplies a finite eye event.
 */
const BLUEPRINTS: readonly VariantBlueprint[] = [
  {
    key: "present",
    label: "Present",
    gesture: "still",
    accents: profiles({ positive: "none", tender: "soften", playful: "none", curious: "none", hostile: "none", neutral: "none" }),
    smiles: profiles({ positive: 0.04, tender: 0, playful: 0.04, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 2, widthRight: 1, heightLeft: 5, heightRight: 3, positionYLeft: -2, positionYRight: -2, leftAngle: -2, rightAngle: 2, perspective: 0.02 },
    entryMs: 170,
    holdMs: 420,
    tailMs: 420,
  },
  {
    key: "open",
    label: "Open recognition",
    gesture: "lift",
    accents: profiles({ positive: "spark", tender: "soften", playful: "widen", curious: "widen", hostile: "widen", neutral: "widen" }),
    smiles: profiles({ positive: 0.12, tender: 0, playful: 0.08, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 9, widthRight: 7, heightLeft: 15, heightRight: 12, spacing: 7, positionYLeft: -5, positionYRight: -5, leftAngle: -3, rightAngle: 3, perspective: 0.04 },
    entryMs: 130,
    holdMs: 430,
    tailMs: 520,
  },
  {
    key: "left-focus",
    label: "Left focus",
    gesture: "tilt-left",
    accents: profiles({ positive: "glance-left", tender: "look-away", playful: "flick-left", curious: "glance-left", hostile: "flick-left", neutral: "glance-left" }),
    smiles: profiles({ positive: 0.04, tender: 0, playful: 0.08, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 10, widthRight: -3, heightLeft: 8, heightRight: -8, spacing: 5, positionXLeft: -7, positionXRight: -3, positionYLeft: -2, positionYRight: 2, leftAngle: -9, rightAngle: 7, perspective: -0.02 },
    entryMs: 190,
    holdMs: 390,
    tailMs: 560,
  },
  {
    key: "right-focus",
    label: "Right focus",
    gesture: "tilt-right",
    accents: profiles({ positive: "glance-right", tender: "look-away", playful: "flick-right", curious: "glance-right", hostile: "flick-right", neutral: "glance-right" }),
    smiles: profiles({ positive: 0.05, tender: 0, playful: 0.08, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: -3, widthRight: 10, heightLeft: -8, heightRight: 8, spacing: 5, positionXLeft: 3, positionXRight: 7, positionYLeft: 2, positionYRight: -2, leftAngle: -7, rightAngle: 9, perspective: 0.02 },
    entryMs: 190,
    holdMs: 390,
    tailMs: 560,
  },
  {
    key: "look-up",
    label: "Look up",
    gesture: "lean-in",
    accents: profiles({ positive: "glance-up", tender: "glance-down", playful: "double-take", curious: "glance-up", hostile: "widen", neutral: "glance-up" }),
    smiles: profiles({ positive: 0.08, tender: 0, playful: 0.06, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 5, widthRight: 6, heightLeft: 11, heightRight: 9, spacing: 3, positionYLeft: -12, positionYRight: -11, leftAngle: -4, rightAngle: 4, perspective: 0.03 },
    entryMs: 160,
    holdMs: 470,
    tailMs: 600,
  },
  {
    key: "soft-down",
    label: "Soft down",
    gesture: "settle",
    accents: profiles({ positive: "soften", tender: "soften", playful: "look-away", curious: "glance-down", hostile: "browless-wince", neutral: "soften" }),
    smiles: profiles({ positive: 0.02, tender: 0, playful: 0.03, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: -2, widthRight: -1, heightLeft: -10, heightRight: -8, spacing: -2, positionYLeft: 10, positionYRight: 10, leftAngle: 8, rightAngle: -8, perspective: -0.03 },
    entryMs: 230,
    holdMs: 510,
    tailMs: 670,
  },
  {
    key: "punctuate",
    label: "Punctuate",
    gesture: "nod",
    accents: profiles({ positive: "double-take", tender: "browless-wince", playful: "squint", curious: "widen", hostile: "squint", neutral: "double-take" }),
    smiles: profiles({ positive: 0.1, tender: 0, playful: 0.12, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 12, widthRight: 8, heightLeft: 18, heightRight: 13, spacing: 9, positionXLeft: -3, positionXRight: 3, positionYLeft: -3, positionYRight: -3, leftAngle: -6, rightAngle: 6, perspective: 0.05 },
    entryMs: 120,
    holdMs: 350,
    tailMs: 500,
  },
  {
    key: "return",
    label: "Return to center",
    gesture: "settle",
    accents: profiles({ positive: "soften", tender: "double-blink", playful: "wink-left", curious: "double-take", hostile: "soften", neutral: "double-blink" }),
    smiles: profiles({ positive: 0.06, tender: 0, playful: 0.08, curious: 0, hostile: 0, neutral: 0 }),
    pose: { widthLeft: 6, widthRight: -2, heightLeft: 4, heightRight: -4, spacing: 2, positionXLeft: -2, positionXRight: 2, positionYLeft: 3, positionYRight: 3, leftAngle: 5, rightAngle: -5, perspective: 0 },
    entryMs: 210,
    holdMs: 460,
    tailMs: 720,
  },
];

const expressionLabel = (expression: SemanticExpression) => expression[0].toUpperCase() + expression.slice(1);

const variants = semanticExpressions.flatMap((expression): CharacterVariant[] => {
  const profile = profileFor(expression);
  return BLUEPRINTS.map((blueprint) => ({
    id: `${expression}-${blueprint.key}`,
    label: `${expressionLabel(expression)} · ${blueprint.label}`,
    expression,
    intents: CHARACTER_INTENTS.filter((intent) => intentBlueprints(intent, profile).includes(blueprint.key)),
    gesture: blueprint.gesture,
    accent: blueprint.accents[profile],
    pose: mergePose(blueprint.pose, FAMILY_POSE_BIAS[profile]),
    smileDelta: blueprint.smiles[profile],
    entryMs: blueprint.entryMs,
    holdMs: blueprint.holdMs,
    tailMs: blueprint.tailMs,
  }));
});

export const CHARACTER_VARIANTS: readonly CharacterVariant[] = variants;

const variantById = new Map(CHARACTER_VARIANTS.map((variant) => [variant.id, variant]));

export function getCharacterVariant(id: string | undefined | null): CharacterVariant | undefined {
  return id ? variantById.get(id) : undefined;
}

export function variantsFor(
  expression: SemanticExpression,
  intent?: CharacterIntent,
): readonly CharacterVariant[] {
  const all = CHARACTER_VARIANTS.filter((variant) => variant.expression === expression);
  if (!intent) return all;
  const matching = all.filter((variant) => variant.intents.includes(intent));
  return matching.length ? matching : all;
}

export function variantDuration(variant: CharacterVariant): number {
  return variant.entryMs + variant.holdMs + variant.tailMs;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Apply a variant to any compatible base portrait. This deliberately accepts
 * the base Expression instead of importing the performance portrait table, so
 * the gallery, tests, and the live controller share the same pure operation.
 */
export function applyCharacterVariant(
  base: Expression,
  variant: CharacterVariant,
  intensity = 1,
  baseSmile = 0,
): { expression: Expression; smile: number } {
  const amount = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  const expression = { ...base };
  for (const [field, delta] of Object.entries(variant.pose) as Array<[keyof CharacterVariantPose, number]>) {
    if (delta === undefined || !Number.isFinite(delta)) continue;
    const current = expression[field];
    if (typeof current === "number" && Number.isFinite(current)) {
      expression[field] = current + delta * amount;
    }
  }

  expression.widthLeft = Math.max(8, expression.widthLeft);
  expression.widthRight = Math.max(8, expression.widthRight);
  expression.heightLeft = Math.max(8, expression.heightLeft);
  expression.heightRight = Math.max(8, expression.heightRight);
  expression.spacing = clamp(expression.spacing, 34, 112);
  expression.positionXLeft = clamp(expression.positionXLeft, -34, 34);
  expression.positionXRight = clamp(expression.positionXRight, -34, 34);
  expression.positionYLeft = clamp(expression.positionYLeft, -34, 34);
  expression.positionYRight = clamp(expression.positionYRight, -34, 34);
  expression.leftAngle = clamp(expression.leftAngle, -55, 55);
  expression.rightAngle = clamp(expression.rightAngle, -55, 55);
  expression.perspective = clamp(expression.perspective, 0.55, 1.45);

  // A delivery variation must not erase the emotion's defining silhouette.
  // The left/right-focus blueprints used to cancel most of the inward tilt,
  // leaving a concerned line looking nearly neutral despite the mood label.
  if (variant.expression === "concerned" || variant.expression === "sad" || variant.expression === "shy") {
    const innerTilt = variant.expression === "sad" ? 24 : variant.expression === "shy" ? 14 : 16;
    const leftTiltFloor = base.leftAngle + (innerTilt - base.leftAngle) * amount;
    const rightTiltCeiling = base.rightAngle + (-innerTilt - base.rightAngle) * amount;
    expression.leftAngle = Math.max(leftTiltFloor, expression.leftAngle);
    expression.rightAngle = Math.min(rightTiltCeiling, expression.rightAngle);
  }

  const smile = clamp((Number.isFinite(baseSmile) ? baseSmile : 0) + variant.smileDelta * amount, 0, 1);
  return { expression, smile };
}
