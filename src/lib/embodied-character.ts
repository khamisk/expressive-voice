import type { SemanticExpression } from "../types";
import { isSemanticExpression, semanticExpressions } from "./expressions";
import { CHARACTER_ACCENTS, type CharacterAccent } from "./character-accents";
import { CHARACTER_GESTURES, type CharacterGesture } from "./character-gestures";
import { CHARACTER_INTENTS, isCharacterIntent, type CharacterIntent } from "./character-intents";
import { REACTION_EFFECTS, reactionEffectFits, type ReactionEffect } from "./reaction-cues";

/** The one optional tool the native voice can use to perform the character. */
export const CHARACTER_TOOL_NAME = "perform_character" as const;
export const CHARACTER_PERFORMANCE_MAX_BEATS = 4;
export const CHARACTER_ANCHOR_MAX_LENGTH = 48;
export const CHARACTER_ANCHOR_MAX_WORDS = 8;
export const MAX_CHARACTER_PERFORMANCE_ARGUMENT_CHARS = 4096;
export const MAX_CHARACTER_PERFORMANCE_ARGUMENT_BYTES = 8192;

export type CharacterPerformanceBeat = {
  expression: SemanticExpression;
  intensity: number;
  /** Empty only on the first beat; otherwise an upcoming spoken phrase. */
  anchor: string;
  intent: CharacterIntent;
  gesture: CharacterGesture;
  accent: CharacterAccent;
  effect: ReactionEffect;
};

export type CharacterPerformance = {
  silent: boolean;
  beats: CharacterPerformanceBeat[];
};

/** Explicit names for consumers that want to distinguish parsed data from raw tool JSON. */
export type NormalizedCharacterPerformanceBeat = CharacterPerformanceBeat;
export type NormalizedCharacterPerformance = CharacterPerformance;

export type ParseCharacterPerformanceOptions = {
  /** When known, validate that non-empty anchors occur in spoken order. */
  spokenText?: string;
  /** Alias for callers that keep the provider's assistant text under this name. */
  assistantText?: string;
  /** Alias used by the existing reaction-plan parser. */
  currentAssistantText?: string;
};

const reactionEffects: readonly ReactionEffect[] = REACTION_EFFECTS;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => (
  Object.keys(value).every((key) => allowed.includes(key))
);

const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();
const anchorKey = (value: string): string => normalizeWhitespace(value).toLowerCase();

function isReactionEffect(value: unknown): value is ReactionEffect {
  return typeof value === "string" && reactionEffects.includes(value as ReactionEffect);
}

function isCharacterAccent(value: unknown): value is CharacterAccent {
  return typeof value === "string" && CHARACTER_ACCENTS.includes(value as CharacterAccent);
}

function isCharacterGesture(value: unknown): value is CharacterGesture {
  return typeof value === "string" && CHARACTER_GESTURES.includes(value as CharacterGesture);
}

function isFiniteIntensity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validAnchor(value: unknown, first: boolean): string | null {
  if (typeof value !== "string") return null;
  const anchor = normalizeWhitespace(value);
  if (!anchor) return first ? "" : null;
  if (anchor.length > CHARACTER_ANCHOR_MAX_LENGTH) return null;
  if (anchor.split(" ").length > CHARACTER_ANCHOR_MAX_WORDS) return null;
  // An anchor should point at spoken words, not be a decorative punctuation
  // payload or an instruction disguised as a phrase.
  if (!/[\p{L}\p{N}]/u.test(anchor)) return null;
  return anchor;
}

function normalizeSpokenText(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function findAnchorPosition(text: string, anchor: string, from: number): number {
  const normalizedText = normalizeSpokenText(text);
  const normalizedAnchor = anchorKey(anchor);
  if (!normalizedAnchor) return -1;

  let position = normalizedText.indexOf(normalizedAnchor, Math.max(0, from));
  while (position >= 0) {
    const before = position === 0 ? "" : normalizedText[position - 1];
    const after = normalizedText[position + normalizedAnchor.length] ?? "";
    const beforeWord = /[\p{L}\p{N}]/u.test(before);
    const afterWord = /[\p{L}\p{N}]/u.test(after);
    if (!beforeWord && !afterWord) return position;
    position = normalizedText.indexOf(normalizedAnchor, position + 1);
  }
  return -1;
}

function parseJson(raw: string): unknown | null {
  if (typeof raw !== "string" || raw.length > MAX_CHARACTER_PERFORMANCE_ARGUMENT_CHARS) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_CHARACTER_PERFORMANCE_ARGUMENT_BYTES) return null;

  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const source = fenced?.[1]?.trim() ?? trimmed;
  if (!source) return null;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parse and locally normalize the voice tool's output. This is intentionally
 * a structural validator, not an emotion classifier: a direct request such
 * as "make a surprised face" must preserve the selected expression.
 */
export function parseCharacterPerformance(
  raw: string,
  options: ParseCharacterPerformanceOptions | string = {},
): NormalizedCharacterPerformance | null {
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["silent", "beats"])) return null;

  const silent = parsed.silent;
  const rawBeats = parsed.beats;
  if (typeof silent !== "boolean" || !Array.isArray(rawBeats)) return null;
  if (rawBeats.length > CHARACTER_PERFORMANCE_MAX_BEATS) return null;
  // A silent call is an explicit nonverbal performance request, so it must
  // contain exactly one immediate face beat. It cannot smuggle spoken anchors
  // or a multi-beat schedule into a no-audio response.
  if (silent && rawBeats.length !== 1) return null;
  if (!silent && rawBeats.length === 0) return null;

  const spokenText = typeof options === "string"
    ? options
    : options.spokenText ?? options.assistantText ?? options.currentAssistantText;
  if (spokenText !== undefined && typeof spokenText !== "string") return null;

  const beats: CharacterPerformanceBeat[] = [];
  const seenAnchors = new Set<string>();
  let previousAnchorPosition = -1;

  for (const [index, rawBeat] of rawBeats.entries()) {
    if (!isRecord(rawBeat)) return null;
    if (!hasOnlyKeys(rawBeat, ["expression", "intensity", "anchor", "intent", "gesture", "accent", "effect"])) {
      return null;
    }

    const expression = rawBeat.expression;
    const intensity = rawBeat.intensity;
    const anchor = validAnchor(rawBeat.anchor, index === 0);
    if (!isSemanticExpression(expression) || !isFiniteIntensity(intensity) || anchor === null) return null;
    if (silent && (index !== 0 || anchor !== "")) return null;

    if (anchor) {
      const key = anchorKey(anchor);
      if (seenAnchors.has(key)) return null;
      seenAnchors.add(key);
      if (spokenText !== undefined) {
        const position = findAnchorPosition(spokenText, anchor, previousAnchorPosition + 1);
        if (position < 0 || position <= previousAnchorPosition) return null;
        previousAnchorPosition = position;
      }
    }

    if (rawBeat.intent !== undefined && !isCharacterIntent(rawBeat.intent)) return null;
    if (rawBeat.gesture !== undefined && !isCharacterGesture(rawBeat.gesture)) return null;
    if (rawBeat.accent !== undefined && !isCharacterAccent(rawBeat.accent)) return null;
    if (rawBeat.effect !== undefined && !isReactionEffect(rawBeat.effect)) return null;

    // Defaults stay deliberately neutral and composable. The renderer can
    // layer its authored expression family on top, while a caller that wants
    // a particular head beat or accent must opt into it explicitly.
    const gesture: CharacterGesture = rawBeat.gesture === undefined
      ? "still"
      : rawBeat.gesture;
    const accent: CharacterAccent = rawBeat.accent === undefined
      ? "none"
      : rawBeat.accent;
    const requestedEffect = rawBeat.effect === undefined ? "none" : rawBeat.effect;
    // The renderer has no meaningful interpretation for a decorative effect
    // that does not fit the chosen face. Normalize it away, especially for
    // negative/vulnerable expressions, instead of letting it leak visually.
    const effect = requestedEffect !== "none" && !reactionEffectFits(expression, requestedEffect)
      ? "none"
      : requestedEffect;

    beats.push({
      expression,
      intensity,
      anchor,
      intent: rawBeat.intent === undefined ? "react" : rawBeat.intent,
      gesture,
      accent,
      effect,
    });
  }

  return { silent, beats };
}

const beatProperties = {
  expression: {
    type: "string",
    enum: semanticExpressions,
    description: "Direct semantic face shape; preserve the chosen expression.",
  },
  intensity: { type: "number", minimum: 0, maximum: 1, description: "Face strength from 0 to 1." },
  anchor: {
    type: "string",
    maxLength: CHARACTER_ANCHOR_MAX_LENGTH,
    description: "Empty only for the first immediate beat; later values are exact short upcoming spoken phrases.",
  },
  intent: { type: "string", enum: CHARACTER_INTENTS, description: "Why this beat is happening." },
  gesture: { type: "string", enum: CHARACTER_GESTURES, description: "Meaningful authored head gesture." },
  accent: { type: "string", enum: CHARACTER_ACCENTS, description: "Finite eye accent for this beat." },
  effect: {
    type: "string",
    enum: reactionEffects,
    description: "Small one-shot effect: confetti for an earned win, pop for real surprise, laugh for clear amusement, sparkle for a playful reveal, the heart key for a friendly golden greeting mark on thanks, encouragement, a shared win, or genuine relief (not a literal heart or romance), question for puzzlement, idea for an explicit realization, anger for clearly expressed frustration or anger, or none for distress, vulnerability, and ordinary facts.",
  },
} as const;

/**
 * GA Realtime function-tool schema. Do not add `strict`: Realtime function
 * tools do not accept a top-level strict property, so arguments are validated
 * by parseCharacterPerformance after the call arrives.
 */
export const CHARACTER_TOOL = {
  type: "function",
  name: CHARACTER_TOOL_NAME,
  description: "Optionally perform the white character at most once per assistant reply, not once per session and not every sentence. Use it for a meaningful moment or changed intent, including an explicit face request, even without literal face wording; plain acknowledgements and facts need no call. Use confetti for an earned win, pop for real surprise, laugh for clear amusement, sparkle for a playful reveal, the heart key for a friendly golden greeting mark on thanks, encouragement, a shared win, or genuine relief (not a literal heart or romance), question for puzzlement, idea for an explicit realization, and anger only for clearly expressed frustration or anger; use none for distress, vulnerability, and ordinary facts. The anger effect is one small bubbly forehead mark, never a general decoration. silent defaults false, so a face request still gets a spoken reply unless the user explicitly asks for no words. For speech, the first empty anchor acts immediately and later anchors are exact upcoming words. For silence, provide exactly one immediate face beat. Do not volunteer labels; answer direct face-state questions from App context.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      silent: {
        type: "boolean",
        default: false,
        description: "False by default; true only for an explicit no-words, without-speaking, or silent face request.",
      },
      beats: {
        type: "array",
        minItems: 1,
        maxItems: CHARACTER_PERFORMANCE_MAX_BEATS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: beatProperties,
          required: ["expression", "intensity", "anchor", "intent", "gesture", "accent", "effect"],
        },
      },
    },
    required: ["silent", "beats"],
  },
} as const;
