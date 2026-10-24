import type { Expression } from "@bible-strong/avatar-core";
import type { AvatarExpression } from "../types";

/**
 * Finite accents are intentionally small authored events.  They are not an
 * idle animator: the performance controller only starts one after a phrase
 * or audio-gated word tick.  Combining these with the semantic portraits and
 * seven head gestures gives a much larger vocabulary without random motion.
 */
export const CHARACTER_ACCENTS = [
  "none",
  "widen",
  "soften",
  "squint",
  "wink-left",
  "wink-right",
  "browless-wince",
  "spark",
  "glance-left",
  "glance-right",
  "glance-up",
  "glance-down",
  "flick-left",
  "flick-right",
  "double-blink",
  "double-take",
  "look-away",
  "eye-roll",
] as const;
export type CharacterAccent = (typeof CHARACTER_ACCENTS)[number];

const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const pulse = (time: number, rise: number, hold: number, fall: number) => time < 0 ? 0
  : time < rise ? ease(time / rise)
    : time < rise + hold ? 1
      : 1 - ease((time - rise - hold) / fall);

export function reactionAccent(expression: AvatarExpression): CharacterAccent {
  if (["excited", "delighted", "joyful", "proud"].includes(expression)) return "spark";
  if (["surprised", "curious"].includes(expression)) return "widen";
  if (["concerned", "sad", "relieved"].includes(expression)) return "soften";
  if (expression === "amused") return "squint";
  if (expression === "playful") return "wink-right";
  return "none";
}

function accentHash(expression: AvatarExpression, tick: number, context = ""): number {
  // Hash the authored event identity instead of taking tick modulo a short
  // hand-written cycle. A Murmur-style avalanche is important here: adjacent
  // integer ticks otherwise have correlated high bits and can map to the same
  // accent for half a sentence. Context separates otherwise identical short
  // turns while keeping replay deterministic.
  let hash = 2166136261;
  const seed = `${context}:${expression}:${Math.trunc(tick)}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function pickAccent(
  expression: AvatarExpression,
  tick: number,
  candidates: readonly CharacterAccent[],
  context: string,
): CharacterAccent {
  if (candidates.length === 0) return "none";
  const event = Number.isFinite(tick) ? Math.max(0, Math.trunc(tick)) : 0;
  const bag = Math.floor(event / candidates.length);
  const order = candidates.map((_, index) => index);
  // One of each eligible accent per bag, with a new context-seeded ordering
  // in every bag. Unlike comparing neighboring raw hash values, this also
  // prevents a long raw duplicate run from becoming a long run of the SAME
  // alternate. A duplicate is possible only across two bag boundaries.
  for (let index = order.length - 1; index > 0; index -= 1) {
    const random = accentHash(expression, index, `${context}:bag:${bag}`) / 4294967296;
    const swap = Math.floor(random * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return candidates[order[event % candidates.length]];
}

/** Selects a small shape accent from the audible word clock. Looking away,
 * rolling eyes, and blinking are complete gestures with meaning, not things
 * to shuffle onto arbitrary syllables. They remain available to authored
 * cues/idle performances; words articulate the face already being performed.
 */
export function speechAccentForTick(
  expression: AvatarExpression,
  tick: number,
  punctuation: "none" | "comma" | "sentence" | "question" | "exclamation" = "none",
  context = "",
): CharacterAccent {
  if (punctuation === "question") return "widen";
  if (punctuation === "exclamation") {
    // A loud punctuation mark is not automatically happy. Keep sparkle for
    // earned delight; concern/sadness gets a visible wince instead.
    if (isPositiveExpression(expression)) return "spark";
    if (isTenderExpression(expression)) return "browless-wince";
    if (["angry", "frustrated", "determined"].includes(expression)) return "squint";
    return "widen";
  }
  if (punctuation === "comma") {
    if (expression === "playful" || expression === "amused") return "squint";
    return "soften";
  }
  const source: readonly CharacterAccent[] = isPositiveExpression(expression)
    ? ["widen", "spark", "soften", "squint"]
    : isTenderExpression(expression) || ["angry", "frustrated", "determined"].includes(expression)
      ? ["soften", "browless-wince", "squint", "widen"]
      : ["widen", "soften", "spark", "squint"];
  return pickAccent(expression, tick, source, context);
}

function isPositiveExpression(expression: AvatarExpression): boolean {
  return ["delighted", "joyful", "excited", "proud"].includes(expression);
}

function isTenderExpression(expression: AvatarExpression): boolean {
  return ["concerned", "sad", "shy", "relieved"].includes(expression);
}

/**
 * A reusable vocabulary, not a phrase lookup or random twitch generator.
 * Eye shape × contextual head gesture × one accent yields many performances.
 * Every accent has a finite envelope and blends through the physical face.
 */
export function applyCharacterAccent(
  expression: Expression,
  smile: number,
  accent: CharacterAccent,
  elapsed: number,
  intensity: number,
  timing: "semantic" | "speech" = "semantic",
): { expression: Expression; smile: number; openness: number } {
  const face = { ...expression };
  // The word layer must crest before the next word arrives. The old 140ms
  // dead start + 170ms rise was repeatedly reset at a 220–240ms word cadence,
  // so articulation stayed near zero. Semantic accents retain their deliberate
  // hold, while beginning with the meaning rather than after a blank delay.
  const envelope = timing === "speech"
    ? pulse(elapsed, 65, 35, 170)
    : pulse(elapsed, 150, 160, 350);
  const amount = envelope * Math.max(0, Math.min(1, intensity));
  let openness = 1;
  switch (accent) {
    case "widen":
      face.widthLeft += 9 * amount; face.widthRight += 7 * amount;
      face.heightLeft += 15 * amount; face.heightRight += 11 * amount;
      break;
    case "soften":
      face.heightLeft -= 9 * amount; face.heightRight -= 7 * amount;
      face.leftAngle += 6 * amount; face.rightAngle -= 6 * amount;
      face.positionYLeft += 3 * amount; face.positionYRight += 3 * amount;
      break;
    case "squint":
      face.heightLeft *= 1 - 0.32 * amount; face.heightRight *= 1 - 0.24 * amount;
      face.widthLeft += 5 * amount; face.widthRight += 4 * amount;
      smile += 0.15 * amount;
      break;
    case "wink-left":
    case "wink-right": {
      const side = accent === "wink-left" ? "Left" : "Right";
      const height = side === "Left" ? "heightLeft" : "heightRight";
      const width = side === "Left" ? "widthLeft" : "widthRight";
      face[height] += (7 - face[height]) * amount;
      face[width] += 7 * amount;
      break;
    }
    case "browless-wince":
      face.heightLeft *= 1 - 0.3 * amount; face.heightRight *= 1 - 0.18 * amount;
      face.leftAngle += 11 * amount; face.rightAngle -= 8 * amount;
      break;
    case "spark":
      face.heightLeft += 17 * amount; face.heightRight += 8 * amount;
      face.widthLeft += 5 * amount; face.widthRight += 2 * amount;
      face.positionYLeft -= 3 * amount;
      break;
    case "glance-left":
    case "glance-right": {
      const direction = accent === "glance-left" ? -1 : 1;
      face.positionXLeft += 12 * direction * amount;
      face.positionXRight += 12 * direction * amount;
      break;
    }
    case "glance-up":
      face.positionYLeft -= 11 * amount; face.positionYRight -= 10 * amount;
      face.leftAngle -= 3 * amount; face.rightAngle += 3 * amount;
      break;
    case "glance-down":
      face.positionYLeft += 11 * amount; face.positionYRight += 10 * amount;
      face.leftAngle += 3 * amount; face.rightAngle -= 3 * amount;
      break;
    case "flick-left":
    case "flick-right": {
      const direction = accent === "flick-left" ? -1 : 1;
      const flickTime = Math.max(0, Math.min(1, (elapsed - 150) / 460));
      // A quick glance away and a returning ease makes a flick read as an
      // intentional thought, rather than the old random-looking drift.
      const flick = Math.sin(Math.PI * flickTime) * direction;
      face.positionXLeft += 15 * flick * amount;
      face.positionXRight += 15 * flick * amount;
      face.positionYLeft += 4 * Math.sin(Math.PI * flickTime) * amount;
      face.positionYRight += 3 * Math.sin(Math.PI * flickTime) * amount;
      break;
    }
    case "double-take": {
      const takeTime = Math.max(0, Math.min(1, (elapsed - 130) / 650));
      const take = Math.sin(Math.PI * takeTime);
      face.widthLeft += 8 * take * amount;
      face.widthRight += 8 * take * amount;
      face.heightLeft += 10 * take * amount;
      face.heightRight += 9 * take * amount;
      face.positionXLeft += 7 * Math.sin(Math.PI * takeTime * 2) * amount;
      face.positionXRight += 7 * Math.sin(Math.PI * takeTime * 2) * amount;
      break;
    }
    case "look-away": {
      const awayTime = Math.max(0, Math.min(1, (elapsed - 130) / 620));
      const away = Math.sin(Math.PI * awayTime);
      face.positionXLeft += 13 * away * amount;
      face.positionXRight += 13 * away * amount;
      face.positionYLeft += 5 * away * amount;
      face.positionYRight += 5 * away * amount;
      face.leftAngle += 4 * away * amount;
      face.rightAngle -= 4 * away * amount;
      break;
    }
    case "eye-roll": {
      // Finite 3/4-circle travel: up, across, then down and back to center.
      // It is only selected for playful disbelief; it never runs as idle.
      const rollTime = Math.max(0, Math.min(1, (elapsed - 120) / 760));
      const rollEnvelope = pulse(elapsed - 120, 120, 600, 300);
      const rollAngle = -Math.PI * 0.72 + rollTime * Math.PI * 1.55;
      const rollX = Math.cos(rollAngle) * 14 * rollEnvelope * intensity;
      const rollY = Math.sin(rollAngle) * 11 * rollEnvelope * intensity;
      face.positionXLeft += rollX;
      face.positionXRight += rollX;
      face.positionYLeft += rollY;
      face.positionYRight += rollY;
      face.leftAngle += 5 * Math.sin(rollAngle) * rollEnvelope * intensity;
      face.rightAngle += 5 * Math.sin(rollAngle) * rollEnvelope * intensity;
      break;
    }
    case "double-blink":
      openness = 1 - Math.max(pulse(elapsed - 160, 95, 10, 145), pulse(elapsed - 520, 95, 10, 145)) * intensity;
      break;
  }
  // Keep even exaggerated combinations renderable. This is a safety floor,
  // not a visual clamp on the authored silhouettes.
  face.widthLeft = Math.max(4, face.widthLeft);
  face.widthRight = Math.max(4, face.widthRight);
  face.heightLeft = Math.max(4, face.heightLeft);
  face.heightRight = Math.max(4, face.heightRight);
  return { expression: face, smile, openness };
}
