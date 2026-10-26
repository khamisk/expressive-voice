import { expressionFields, expressionFromDefinition, type Expression } from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import { reactionEffectFits, type ReactionCue, type ReactionEffect } from "./reaction-cues";
import { EFFECT_DURATION, type ActiveEffect } from "./reaction-effects";
import {
  REST_GESTURE,
  gestureDuration,
  reactionGesture,
  sampleGesture,
  type CharacterGesture,
  type GesturePose,
} from "./character-gestures";
import { applyCharacterAccent, reactionAccent, speechAccentForTick, type CharacterAccent } from "./character-accents";
import {
  applyCharacterVariant,
  getCharacterVariant,
  isCharacterIntent,
  variantDuration,
  variantsFor,
  type CharacterIntent,
  type CharacterVariant,
} from "./character-variants";
import type { AvatarExpression, ConversationPhase, SemanticExpression } from "../types";
export { smileEyePath } from "./eye-shapes";

export type SpeechPunctuation = "none" | "comma" | "sentence" | "question" | "exclamation";

/**
 * `wordTick` and `phraseTick` are monotonically increasing audio-gated event
 * counters. They are optional so recorded scenes, the expression gallery,
 * and older clients can keep using amplitude-only activity. When present,
 * they are the clock for authored micro-beats; output amplitude only adds
 * tiny articulation to the current silhouette.
 *
 * `syllableTick` comes from the voice audio itself (VoiceBeatDetector), not
 * from the transcript estimate. When present it drives a short pulse per
 * heard syllable, scaled by `syllableStrength`, in place of the slower
 * loudness-onset accent.
 */
export type VoiceActivity = {
  input: number;
  output: number;
  wordTick?: number;
  phraseTick?: number;
  punctuation?: SpeechPunctuation;
  syllableTick?: number;
  syllableStrength?: number;
};

/** A syllable pulse rises quickly and settles before the next syllable. */
const SYLLABLE_RISE_MS = 45;
const SYLLABLE_FALL_MS = 170;

function syllableEnvelope(age: number): number {
  if (age < 0) return 0;
  if (age < SYLLABLE_RISE_MS) {
    const p = age / SYLLABLE_RISE_MS;
    return p * p * (3 - 2 * p);
  }
  const p = Math.min(1, (age - SYLLABLE_RISE_MS) / SYLLABLE_FALL_MS);
  return (1 - p) * (1 - p);
}
export type FacePerformanceInput = {
  phase: ConversationPhase;
  expression: AvatarExpression;
  activity: VoiceActivity;
  cue?: ReactionCue | null;
  reducedMotion?: boolean;
  /** Gallery-only effect inspection is independent of the face; live turns retain semantic guards. */
  effectPreview?: boolean;
  /** Independent one-shot for the gallery; never restarts the facial cue. */
  previewEffect?: { id: string; kind: ReactionEffect };
};

function portrait(reference: string, overrides: Partial<Expression>): Expression {
  return {
    ...expressionFromDefinition(reference, performanceAvatarDefinition.expressions[reference]),
    positionXLeft: 0, positionXRight: 0, positionYLeft: 0, positionYRight: 0,
    eyeMotion: "none", bodyMotion: "none",
    ...overrides,
    // Resting portraits have no orbit. A spoken beat may author a small head
    // gesture separately, so a shape and its timing remain independent.
    headX: 0, headY: 0, headZ: 0,
  };
}

// These are silhouettes, not animation loops. Large eyes remain the default.
export const speakingPortraits: Record<AvatarExpression, Expression> = {
  neutral: portrait("neutral", { widthLeft: 36, widthRight: 36, heightLeft: 68, heightRight: 68, spacing: 66, positionYLeft: -5, positionYRight: -5 }),
  attentive: portrait("attentive-left", { widthLeft: 33, widthRight: 33, heightLeft: 76, heightRight: 72, spacing: 66 }),
  thinking: portrait("neutral", { widthLeft: 33, widthRight: 32, heightLeft: 63, heightRight: 58, spacing: 66 }),
  curious: portrait("curious-left", { widthLeft: 40, widthRight: 32, heightLeft: 81, heightRight: 48, spacing: 71, leftAngle: -10, rightAngle: 14, positionYLeft: -9, positionYRight: -1 }),
  delighted: portrait("joyful-wide", { widthLeft: 49, widthRight: 46, heightLeft: 84, heightRight: 78, spacing: 78, leftAngle: -6, rightAngle: 6, positionYLeft: -8, positionYRight: -7 }),
  // Warmth rests in open eyes. The closed smile is a finite semantic beat,
  // never the silhouette held for the rest of a friendly conversation.
  joyful: portrait("joyful-wide", { widthLeft: 44, widthRight: 42, heightLeft: 78, heightRight: 74, spacing: 76, leftAngle: -4, rightAngle: 4, positionYLeft: -3, positionYRight: -2 }),
  excited: portrait("joyful-wide", { widthLeft: 48, widthRight: 45, heightLeft: 96, heightRight: 89, spacing: 81, leftAngle: -9, rightAngle: 9, positionYLeft: -5, positionYRight: 0 }),
  amused: portrait("neutral", { widthLeft: 44, widthRight: 39, heightLeft: 64, heightRight: 72, spacing: 76, leftAngle: -7, rightAngle: 3, positionYLeft: 1, positionYRight: -2 }),
  surprised: portrait("surprised-wide-left", { widthLeft: 62, widthRight: 60, heightLeft: 73, heightRight: 71, spacing: 84, positionYLeft: -10, positionYRight: -8, leftAngle: -2, rightAngle: 2 }),
  skeptical: portrait("skeptical-left", { widthLeft: 37, widthRight: 55, heightLeft: 80, heightRight: 21, spacing: 74, rightAngle: -9, positionYLeft: -4, positionYRight: 11 }),
  confused: portrait("asymmetric-up-left", { widthLeft: 48, widthRight: 32, heightLeft: 67, heightRight: 42, spacing: 76, leftAngle: -7, rightAngle: 12 }),
  concerned: portrait("uneasy-left", { widthLeft: 37, widthRight: 36, heightLeft: 57, heightRight: 54, spacing: 69, leftAngle: 20, rightAngle: -20, positionYLeft: 8, positionYRight: 10 }),
  sad: portrait("uneasy-left", { widthLeft: 39, widthRight: 38, heightLeft: 54, heightRight: 51, spacing: 71, leftAngle: 30, rightAngle: -30, positionYLeft: 12, positionYRight: 14 }),
  shy: portrait("shy-downward", { widthLeft: 35, widthRight: 34, heightLeft: 58, heightRight: 53, spacing: 65, positionYLeft: 15, positionYRight: 17, leftAngle: 18, rightAngle: -18 }),
  proud: portrait("joyful-down-right", { widthLeft: 39, widthRight: 37, heightLeft: 78, heightRight: 73, spacing: 72, leftAngle: -8, rightAngle: 8 }),
  playful: portrait("skeptical-right", { widthLeft: 43, widthRight: 53, heightLeft: 79, heightRight: 24, spacing: 79, leftAngle: 6, rightAngle: -8, positionYLeft: -5, positionYRight: 5 }),
  determined: portrait("angry-left", { widthLeft: 36, widthRight: 36, heightLeft: 67, heightRight: 67, spacing: 69, leftAngle: -19, rightAngle: 19 }),
  frustrated: portrait("angry-right", { widthLeft: 36, widthRight: 46, heightLeft: 68, heightRight: 31, spacing: 72, leftAngle: -20, rightAngle: 12 }),
  angry: portrait("angry-brows", { widthLeft: 37, widthRight: 37, heightLeft: 71, heightRight: 71, spacing: 73, leftAngle: -30, rightAngle: 30 }),
  relieved: portrait("neutral", { widthLeft: 36, widthRight: 35, heightLeft: 64, heightRight: 61, spacing: 70, leftAngle: -3, rightAngle: 3, positionYLeft: 3, positionYRight: 4 }),
  sleepy: portrait("drowsy-closed", { widthLeft: 49, widthRight: 48, heightLeft: 32, heightRight: 30, spacing: 70, positionYLeft: 7, positionYRight: 7 }),
};

export const featuredExpressions: AvatarExpression[] = [
  "attentive", "curious", "joyful", "surprised", "playful", "skeptical", "concerned", "relieved",
];

const unit = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const smooth = (n: number) => { const p = unit(n); return p * p * (3 - 2 * p); };
const damp = (a: number, b: number, dt: number, seconds: number) => a + (b - a) * (1 - Math.exp(-dt / seconds));
const isSoft = (mood: AvatarExpression) => ["sad", "concerned", "shy", "sleepy", "relieved"].includes(mood);
const smileFor = (mood: AvatarExpression) => mood === "joyful" ? 0.16 : mood === "amused" ? 0.18 : mood === "relieved" ? 0.1 : mood === "playful" ? 0.25 : 0;

type Portrait = { expression: Expression; smile: number };
type Beat = {
  at: number;
  face: AvatarExpression;
  smile?: number;
  label: string;
};
type ActingCue = ReactionCue & {
  intent?: CharacterIntent;
  variant?: string;
};
type Track = {
  cue: ReactionCue;
  startedAt: number | null;
  beats: Beat[];
  startPose: Portrait | null;
  startGesture: GesturePose | null;
  variant: CharacterVariant;
  intent: CharacterIntent;
  /** Omitted gestures use the expression's semantic default; explicit `still` stays still. */
  gestureExplicit: boolean;
  /** True when the reaction was already on screen before assistant audio began. */
  startedBeforeSpeech: boolean;
};
type BodyPose = { x: number; y: number; scale: number; squashX: number; squashY: number };
type MicroBeat = {
  face: AvatarExpression;
  smile?: number;
  gesture: Parameters<typeof sampleGesture>[0];
  accent: CharacterAccent;
  startedAt: number;
  /** The word accent has its own short clock; it must not restart the face. */
  accentStartedAt: number;
  startPose: Portrait;
  startGesture: GesturePose;
  duration: number;
  source: "phrase" | "word";
  label: string;
  variant: CharacterVariant;
  intent: CharacterIntent;
  /** The phrase owns the semantic silhouette for its whole anchored thought. */
  variantStartedAt: number;
  gestureStartedAt: number;
  gestureStart: GesturePose;
  /** Word accents may replace `source`, but must not revoke a phrase gesture. */
  phraseOwnsGesture: boolean;
};
type IdleBeat = {
  face: AvatarExpression;
  accent: CharacterAccent;
  gesture: Parameters<typeof sampleGesture>[0];
  duration: number;
  pause: number;
  label: string;
};
// Word timestamps can arrive every 200–240ms. Let the eyes respond to each
// event while the larger head gesture remains independently owned by the
// current cue. The anti-repeat variant bank keeps this from becoming a loop.
const MIN_WORD_BEAT_INTERVAL_MS = 220;

/** Effects last two seconds; this small handoff keeps a later earned moment
 * from being swallowed by an old burst without stacking particles. */
export const EFFECT_COOLDOWN_MS = 2400;

/**
 * Kept as a compatibility helper for recorded scenes. Word ticks no longer
 * pick a different semantic mood: a neutral line stays neutral and gets its
 * variation from the authored eye variants/accent track instead.
 */
export function phraseFace(expression: AvatarExpression, index: number): AvatarExpression {
  void index;
  return expression;
}

/** Listening/idle looks are short, varied authored beats. The pauses are
 * deliberately uneven so a user does not see a looped camera tour. */
const idleBeats: readonly IdleBeat[] = [
  { face: "attentive", accent: "glance-left", gesture: "still", duration: 720, pause: 2700, label: "look-left" },
  { face: "curious", accent: "glance-up", gesture: "tilt-right", duration: 950, pause: 3500, label: "look-up" },
  { face: "attentive", accent: "double-blink", gesture: "settle", duration: 680, pause: 2100, label: "blink-think" },
  { face: "attentive", accent: "look-away", gesture: "tilt-left", duration: 980, pause: 4200, label: "look-away" },
  { face: "curious", accent: "glance-down", gesture: "nod", duration: 860, pause: 3000, label: "consider" },
  { face: "attentive", accent: "flick-right", gesture: "still", duration: 760, pause: 3800, label: "side-glance" },
];

function variantHash(seed: string): number {
  // FNV-1a keeps the selection deterministic for replay/gallery QA while the
  // rolling cursor means adjacent beats do not become a simple modulo loop.
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function blendPortrait(a: Portrait, b: Portrait, amount: number): Portrait {
  const expression = { ...a.expression };
  for (const field of expressionFields) expression[field] += (b.expression[field] - expression[field]) * amount;
  return {
    expression,
    smile: a.smile + (b.smile - a.smile) * amount,
  };
}

function poseOf(face: AvatarExpression, smile = smileFor(face), variant?: CharacterVariant): Portrait {
  const base = { ...speakingPortraits[face] };
  // Only an authored smile beat can close both eyes. A retained emotion,
  // decorative effect, audio level, or variant delta cannot keep them shut.
  if (face === "joyful" || face === "amused" || face === "relieved") {
    const closure = smooth((smile - 0.3) / 0.55);
    const width = face === "relieved" ? 48 : 57;
    const height = face === "joyful" ? 42 : face === "amused" ? 30 : 27;
    base.widthLeft += (width - base.widthLeft) * closure;
    base.widthRight += (width - 2 - base.widthRight) * closure;
    base.heightLeft += (height - base.heightLeft) * closure;
    base.heightRight += (height - 2 - base.heightRight) * closure;
  }
  if (!variant) return { expression: base, smile };
  const applied = applyCharacterVariant(base, variant, 1, smile);
  return { expression: applied.expression, smile: applied.smile };
}

function semanticExpressionFor(face: AvatarExpression): SemanticExpression {
  return face === "attentive" || face === "thinking" ? "neutral" : face;
}

function intentForCue(cue: ReactionCue | null | undefined, punctuation: SpeechPunctuation = "none"): CharacterIntent {
  const requested = (cue as ActingCue | null | undefined)?.intent;
  if (isCharacterIntent(requested)) return requested;
  // Legacy/recorded cues have a known emotion but no explicit intent. Do not
  // turn their empathy or surprise into a generic explanatory pose selection.
  if (cue) {
    if (["concerned", "sad", "shy"].includes(cue.expression)) return "comfort";
    if (["amused", "playful"].includes(cue.expression)) return "joke";
    if (["delighted", "excited", "joyful", "proud"].includes(cue.expression)) return "celebrate";
    if (cue.expression === "curious") return "question";
    if (["confused", "skeptical"].includes(cue.expression)) return "consider";
    if (cue.expression === "surprised") return "react";
    if (cue.expression === "relieved") return "reassure";
  }
  if (punctuation === "question") return "question";
  if (punctuation === "exclamation") return "emphasize";
  if (cue?.source === "user") return "react";
  if (cue?.kind === "speech") return "explain";
  return "acknowledge";
}

function reactionBeats(expression: AvatarExpression): Beat[] {
  if (expression === "joyful" || expression === "relieved") return [
    { at: 0, face: expression, label: "recognize" },
    { at: 240, face: expression, smile: 0.35, label: "light-up" },
    { at: 540, face: expression, smile: expression === "joyful" ? 0.9 : 0.7, label: "smile" },
    { at: 840, face: expression, smile: expression === "joyful" ? 0.8 : 0.6, label: "let-it-land" },
    { at: 1420, face: expression, smile: 0.22, label: "reopen" },
    { at: 1820, face: expression, label: "present" },
  ];
  if (expression === "excited") return [
    { at: 0, face: expression, label: "recognize" },
    { at: 220, face: "surprised", label: "light-up" },
    { at: 520, face: "excited", label: "delight" },
    { at: 980, face: "delighted", label: "share-it" },
    { at: 1500, face: "joyful", label: "soften" },
    { at: 2180, face: expression, label: "warm-hold" },
  ];
  if (expression === "delighted" || expression === "proud") return [
    { at: 0, face: expression, label: "recognize" },
    { at: 240, face: "surprised", label: "light-up" },
    { at: 500, face: expression, label: "share-it" },
    { at: 1040, face: expression, label: "warm-hold" },
    { at: 1580, face: expression === "proud" ? "proud" : "joyful", label: "soften" },
    { at: 2180, face: expression, label: "soften" },
  ];
  if (expression === "amused") return [
    // Let a laugh close the eyes briefly, then look back at the other person.
    { at: 0, face: expression, label: "notice" },
    { at: 300, face: expression, smile: 0.75, label: "clock-it" },
    { at: 540, face: expression, smile: 1, label: "smile" },
    { at: 820, face: expression, smile: 0.9, label: "hold-the-joke" },
    { at: 1380, face: expression, smile: 0.28, label: "reopen" },
    { at: 1820, face: expression, label: "present" },
  ];
  if (expression === "playful") return [
    { at: 0, face: expression, label: "notice" },
    { at: 240, face: "skeptical", label: "knowing-look" },
    { at: 500, face: "playful", label: "hold-the-joke" },
    { at: 980, face: "amused", label: "smile" },
    { at: 1520, face: "playful", label: "tease" },
    { at: 2240, face: expression, label: "warm-hold" },
  ];
  if (expression === "sad" || expression === "concerned") return [
    { at: 0, face: expression, label: "listen" },
    { at: 260, face: "concerned", label: "soften" },
    { at: 700, face: expression, label: "stay-with-you" },
    { at: 1250, face: "sad", label: "feel-it" },
    { at: 1820, face: expression, label: "steady" },
  ];
  if (expression === "curious" || expression === "confused" || expression === "skeptical") return [
    { at: 0, face: expression, label: "notice" },
    { at: 240, face: expression, label: "consider" },
    { at: 700, face: "surprised", label: "wait-what" },
    { at: 1160, face: expression, label: "interested-hold" },
    { at: 1860, face: expression, label: "follow-up" },
  ];
  if (expression === "surprised") return [
    { at: 0, face: expression, label: "notice" },
    { at: 180, face: "surprised", label: "surprise" },
    { at: 560, face: "curious", label: "take-it-in" },
    { at: 1050, face: "surprised", label: "still-processing" },
    { at: 1720, face: expression, label: "follow-up" },
  ];
  return [
    { at: 0, face: expression, label: "respond" },
    { at: 280, face: expression, label: "say-it" },
    { at: 820, face: expression, label: "emphasize" },
    { at: 1420, face: expression, label: "let-it-land" },
  ];
}

function speechBeats(expression: AvatarExpression): Beat[] {
  if (expression === "joyful" || expression === "amused" || expression === "relieved") return [
    { at: 0, face: expression, label: "phrase-enter" },
    { at: 170, face: expression, smile: 0.35, label: "anticipate" },
    { at: 410, face: expression, smile: expression === "amused" ? 0.95 : expression === "joyful" ? 0.85 : 0.65, label: "smile" },
    { at: 690, face: expression, smile: expression === "relieved" ? 0.5 : 0.75, label: "land" },
    { at: 1250, face: expression, smile: 0.22, label: "reopen" },
    { at: 1780, face: expression, label: "phrase-hold" },
  ];
  // Meaning stays on the cue's expression for the whole anchored sentence.
  // Eye/head variants provide the phrasing changes; swapping semantic faces
  // here made a neutral explanation look randomly curious or surprised.
  return [
    { at: 0, face: expression, label: "phrase-enter" },
    { at: 170, face: expression, label: "anticipate" },
    { at: 410, face: expression, label: "meaning" },
    { at: 690, face: expression, label: "emphasize" },
    { at: 1010, face: expression, label: "land" },
    { at: 1370, face: expression, label: "breathe" },
    { at: 1780, face: expression, label: "phrase-hold" },
  ];
}

/**
 * A long spoken reply needs more than one physical delivery beat, but those
 * beats must follow the meaning of the line. This is a deterministic small
 * vocabulary used only at phrase boundaries after the first authored gesture
 * has landed. Word ticks never call it.
 */
function phraseGesturePool(expression: AvatarExpression, intent: CharacterIntent): readonly CharacterGesture[] {
  if (["delighted", "joyful", "excited", "proud"].includes(expression)) {
    return intent === "celebrate" ? ["lift", "nod", "lean-in", "settle"] : ["lift", "lean-in", "nod", "settle"];
  }
  if (["concerned", "sad", "shy"].includes(expression)) return ["tilt-left", "settle", "nod", "lean-in"];
  if (["curious", "confused", "skeptical"].includes(expression)) return ["lean-in", "tilt-right", "nod", "settle"];
  if (["amused", "playful"].includes(expression)) return ["tilt-right", "nod", "lean-in", "settle"];
  if (["angry", "frustrated", "determined"].includes(expression)) return ["tilt-left", "nod", "tilt-right", "settle"];
  if (["question", "consider"].includes(intent)) return ["lean-in", "tilt-right", "nod", "settle"];
  if (["comfort", "reassure"].includes(intent)) return ["tilt-left", "settle", "nod", "lean-in"];
  if (["emphasize", "correct", "realize"].includes(intent)) return ["nod", "lift", "settle", "lean-in"];
  return ["nod", "lean-in", "settle", "tilt-right"];
}

function phraseGesture(
  expression: AvatarExpression,
  intent: CharacterIntent,
  variant: CharacterVariant,
  phraseIndex: number,
): CharacterGesture {
  if (variant.gesture !== "still") return variant.gesture;
  const pool = phraseGesturePool(expression, intent);
  return pool[Math.max(0, Math.trunc(phraseIndex)) % pool.length];
}

/** A critically damped spring retains both pose AND velocity across retargets. */
export function springStep(value: number, velocity: number, target: number, dt: number, frequency = 15): [number, number] {
  if (dt <= 0) return [value, velocity];
  const displacement = value - target;
  const impulse = velocity + frequency * displacement;
  const decay = Math.exp(-frequency * dt);
  return [target + (displacement + impulse * dt) * decay, (velocity - frequency * impulse * dt) * decay];
}

/** One physical face: contextual one-shots + audible accents, never a gaze loop. */
export class SpeechPerformance {
  private expression: Expression;
  private velocities = new Map<string, number>();
  private lastTime: number | null = null;
  private energy = 0;
  private sustainedEnergy = 0;
  private speechPresence = 0;
  private listeningPresence = 0;
  private softness = 1;
  private motionScale = 1;
  private smile: number;
  private smileVelocity = 0;
  private body: BodyPose = { x: 0, y: 0, scale: 1, squashX: 1, squashY: 1 };
  private bodyVelocities: BodyPose = { x: 0, y: 0, scale: 0, squashX: 0, squashY: 0 };
  private accentOpenness = 1;
  private accentOpennessVelocity = 0;
  private blinkStartedAt: number | null = null;
  private nextBlinkAt = 4300;
  private blinkIndex = 0;
  private lastAccentAt = -1000;
  private accentStrength = 0;
  private track: Track | null = null;
  private lastCueId: string | null = null;
  private effect: ActiveEffect | null = null;
  private effectTurns = new Set<string>();
  private lastEffectAt = -10000;
  private lastPreviewEffectId: string | null = null;
  private microBeat: MicroBeat | null = null;
  private lastPhraseTick: number | undefined;
  private lastWordTick: number | undefined;
  private tickCueId: string | null = null;
  private lastMicroBeatAt = -Infinity;
  private lastSyllableTick: number | undefined;
  private syllablePulses: Array<{ at: number; strength: number }> = [];
  private idleMotion: {
    beat: IdleBeat;
    startedAt: number;
    startPose: Portrait;
    startGesture: GesturePose;
  } | null = null;
  private idleBeatIndex = 0;
  private recentIdleLabels: string[] = [];
  private nextIdleAt: number | null = null;
  private currentVariant: CharacterVariant;
  private currentIntent: CharacterIntent;
  private recentVariantIds: string[] = [];
  private variantCursor = 0;

  constructor(initial: AvatarExpression = "neutral") {
    this.expression = { ...speakingPortraits[initial] };
    this.smile = smileFor(initial);
    this.currentIntent = "acknowledge";
    this.currentVariant = variantsFor(semanticExpressionFor(initial))[0];
  }

  private rememberVariant(variant: CharacterVariant): CharacterVariant {
    this.currentVariant = variant;
    this.recentVariantIds = [...this.recentVariantIds.filter((id) => id !== variant.id), variant.id].slice(-24);
    return variant;
  }

  /** Capture all visible facial layers together when a new beat takes over. */
  private visiblePortrait(): Portrait {
    return { expression: { ...this.expression }, smile: this.smile };
  }

  private chooseVariant(
    face: AvatarExpression,
    intent: CharacterIntent,
    requestedId: string | undefined,
    seed: string,
  ): CharacterVariant {
    const expression = semanticExpressionFor(face);
    const requested = getCharacterVariant(requestedId);
    if (requested?.expression === expression) {
      this.currentIntent = intent;
      return this.rememberVariant(requested);
    }

    const candidates = variantsFor(expression, intent);
    const recent = new Set(this.recentVariantIds.slice(-Math.min(12, candidates.length - 1)));
    const fresh = candidates.filter((variant) => !recent.has(variant.id));
    const pool = fresh.length ? fresh : candidates;
    const index = variantHash(`${seed}:${this.variantCursor++}`) % pool.length;
    this.currentIntent = intent;
    return this.rememberVariant(pool[index]);
  }

  private chooseIdleBeat(): IdleBeat {
    // Start a fresh listening session with the calm left glance and the
    // upward look. They are the most legible idle pair and keep a just-ended
    // speech gesture from immediately turning into a body bob.
    const ordinal = this.idleBeatIndex++;
    const preferred = ordinal === 0 ? idleBeats[0] : ordinal === 1 ? idleBeats[1] : undefined;
    const recent = new Set(this.recentIdleLabels.slice(-Math.min(3, idleBeats.length - 1)));
    const fresh = idleBeats.filter((beat) => !recent.has(beat.label) && beat !== preferred);
    const pool = fresh.length ? fresh : idleBeats;
    const beat = preferred ?? pool[Math.min(
      pool.length - 1,
      Math.floor((variantHash(`idle:${ordinal}`) / 4294967296) * pool.length),
    )];
    this.recentIdleLabels = [...this.recentIdleLabels.filter((label) => label !== beat.label), beat.label].slice(-6);
    return beat;
  }

  private updateIdle(
    input: FacePerformanceInput,
    time: number,
  ): { beat: IdleBeat; elapsed: number; startPose: Portrait; startGesture: GesturePose } | null {
    const phaseAllowsIdle = (input.phase === "idle" || input.phase === "listening") && !input.cue;
    const inputIsQuiet = input.phase !== "listening" || input.activity.input < 0.16;
    if (!phaseAllowsIdle || !inputIsQuiet || input.reducedMotion) {
      this.idleMotion = null;
      this.nextIdleAt = null;
      return null;
    }
    if (this.nextIdleAt === null) this.nextIdleAt = time + 1050;
    if (this.idleMotion && time - this.idleMotion.startedAt >= this.idleMotion.beat.duration) {
      this.nextIdleAt = time + this.idleMotion.beat.pause;
      this.idleMotion = null;
    }
    if (!this.idleMotion && time >= this.nextIdleAt) {
      const beat = this.chooseIdleBeat();
      this.idleMotion = {
        beat,
        startedAt: time,
        startPose: this.visiblePortrait(),
        startGesture: {
          headX: this.expression.headX,
          headY: this.expression.headY,
          headZ: this.expression.headZ,
          x: this.body.x,
          y: this.body.y,
          scale: this.body.scale,
          squashX: this.body.squashX,
          squashY: this.body.squashY,
        },
      };
    }
    if (!this.idleMotion) return null;
    return {
      beat: this.idleMotion.beat,
      elapsed: time - this.idleMotion.startedAt,
      startPose: this.idleMotion.startPose,
      startGesture: this.idleMotion.startGesture,
    };
  }

  sample(input: FacePerformanceInput, time: number) {
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.05, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const talking = input.phase === "speaking";
    const listening = input.phase === "listening";
    const level = talking ? unit(input.activity.output) : listening ? unit(input.activity.input) : 0;
    const audible = unit((level - 0.018) * 1.65);
    this.energy = damp(this.energy, audible, dt, audible > this.energy ? 0.035 : 0.12);
    this.sustainedEnergy = damp(this.sustainedEnergy, this.energy, dt, 0.3);
    this.speechPresence = damp(this.speechPresence, talking ? 1 : 0, dt, 0.13);
    this.listeningPresence = damp(this.listeningPresence, listening ? 1 : 0, dt, 0.2);
    this.softness = damp(this.softness, isSoft(input.expression) ? 0.48 : 1, dt, 0.18);
    this.motionScale = damp(this.motionScale, input.reducedMotion ? 0.18 : 1, dt, 0.15);

    const syllableTick = input.activity.syllableTick;
    if (syllableTick !== undefined && syllableTick !== this.lastSyllableTick) {
      // Only pulse for a syllable heard while speaking. Ticks that arrive
      // while listening or idle just move the marker so they never replay.
      if (talking && this.lastSyllableTick !== undefined && syllableTick > this.lastSyllableTick) {
        this.syllablePulses.push({ at: time, strength: unit(input.activity.syllableStrength ?? 0.5) });
        if (this.syllablePulses.length > 4) this.syllablePulses.shift();
      }
      this.lastSyllableTick = syllableTick;
    }
    this.syllablePulses = this.syllablePulses.filter((pulse) => time - pulse.at < SYLLABLE_RISE_MS + SYLLABLE_FALL_MS);

    if (input.cue && input.cue.id !== this.lastCueId) {
      this.lastCueId = input.cue.id;
      const cueMeta = input.cue as ActingCue;
      const intent = intentForCue(input.cue);
      const variant = this.chooseVariant(
        input.cue.expression,
        intent,
        cueMeta.variant,
        `${input.cue.turnId}:${input.cue.id}`,
      );
      // Don't let an unrelated idle blink hide the recognition/phrase accent.
      this.nextBlinkAt = Math.max(this.nextBlinkAt, time + 1600);
      this.track = {
        cue: input.cue,
        startedAt: null,
        beats: input.cue.kind === "speech" ? speechBeats(input.cue.expression) : reactionBeats(input.cue.expression),
        startPose: null,
        startGesture: null,
        variant,
        intent,
        gestureExplicit: input.cue.gesture !== undefined,
        startedBeforeSpeech: false,
      };
      this.microBeat = null;
      this.lastPhraseTick = undefined;
      this.lastWordTick = undefined;
      this.tickCueId = input.cue.id;
      this.lastMicroBeatAt = -Infinity;
      // Effects are earned by a semantic moment, not by a turn id. If the
      // director pivots from a celebration to anger/frustration mid-turn,
      // retire the old particles immediately instead of letting them trail
      // over the new meaning. Friendly marks remain valid for relieved/joyful
      // follow-through because reactionEffectFits() explicitly allows that family.
      if (this.effect && ((!input.effectPreview && !reactionEffectFits(input.cue.expression, this.effect.kind))
        || (input.effectPreview && !input.previewEffect && input.cue.effect !== this.effect.kind))) {
        this.effect.retiringAt ??= time;
      }
    } else if (!input.cue && (this.lastCueId !== null || this.track !== null)) {
      this.track = null;
      this.microBeat = null;
      this.lastPhraseTick = undefined;
      this.lastWordTick = undefined;
      this.tickCueId = null;
      this.lastCueId = null;
      this.lastMicroBeatAt = -Infinity;
    }

    if (input.effectPreview && input.previewEffect && input.previewEffect.id !== this.lastPreviewEffectId) {
      this.lastPreviewEffectId = input.previewEffect.id;
      if (input.previewEffect.kind === "none") {
        if (this.effect) this.effect.retiringAt ??= time;
      } else {
        this.effect = { id: input.previewEffect.id, kind: input.previewEffect.kind, startedAt: time, strength: 0.95 };
      }
    }

    // A track can be reused for a long response. The phrase clock owns the
    // semantic silhouette and physical gesture; the word clock only starts a
    // short eye-accent envelope. Rebuilding the whole beat per word made the
    // face look like it was panning randomly and kept accents from cresting.
    const outputActive = talking && level > 0.025;
    const cueForTicks = input.cue?.expression ?? input.expression;
    if (outputActive && (input.activity.phraseTick !== undefined || input.activity.wordTick !== undefined)) {
      const phraseChanged = input.activity.phraseTick !== undefined
        && input.activity.phraseTick !== this.lastPhraseTick;
      const wordChanged = input.activity.wordTick !== undefined
        && input.activity.wordTick !== this.lastWordTick;
      const wordBeatReady = wordChanged && time - this.lastMicroBeatAt >= MIN_WORD_BEAT_INTERVAL_MS;
      if (phraseChanged || wordBeatReady) {
        const phraseTick = input.activity.phraseTick ?? 0;
        const wordTick = input.activity.wordTick ?? phraseTick;
        const punctuation = input.activity.punctuation ?? "none";
        const chosenTick = phraseChanged ? phraseTick : wordTick;
        const intent = intentForCue(input.cue, punctuation);
        const cueMeta = input.cue as ActingCue | null;
        const requestedVariant = getCharacterVariant(cueMeta?.variant);
        const previous = this.microBeat;
        const semanticTrack = this.track && this.track.cue.expression === cueForTicks
          ? this.track
          : null;
        const semanticExpression = semanticExpressionFor(cueForTicks);
        // A cue's variant is already selected when its anchored track is
        // created. Reusing it here is important: the first transcript tick
        // must not select a second silhouette, and later word ticks must not
        // run a 680ms variant lottery. A cue/phrase boundary may still
        // retarget; an unplanned word cannot.
        const allowAnchoredPhraseVariant = Boolean(semanticTrack && previous && phraseChanged && !requestedVariant);
        const baseNeedsRetarget = !previous
          || previous.face !== cueForTicks
          || (!semanticTrack && phraseChanged)
          || Boolean(!semanticTrack && requestedVariant && requestedVariant.id !== previous.variant.id);
        const variant = semanticTrack && !allowAnchoredPhraseVariant
          ? semanticTrack.variant
          : semanticTrack && allowAnchoredPhraseVariant
            ? this.chooseVariant(
              cueForTicks,
              intent,
              undefined,
              `${input.cue?.turnId ?? "speech"}:${input.cue?.id ?? "ticks"}:${chosenTick}:${phraseTick}`,
            )
          : baseNeedsRetarget
            ? requestedVariant && requestedVariant.expression === semanticExpression
              ? this.chooseVariant(
                cueForTicks,
                intent,
                requestedVariant.id,
                `${input.cue?.turnId ?? "speech"}:${input.cue?.id ?? "ticks"}:${chosenTick}:${phraseTick}`,
              )
              : this.chooseVariant(
                cueForTicks,
                intent,
                undefined,
                `${input.cue?.turnId ?? "speech"}:${input.cue?.id ?? "ticks"}:${chosenTick}:${phraseTick}`,
              )
            : previous!.variant;
        const phraseNeedsRetarget = !previous
          || previous.face !== cueForTicks
          || (!semanticTrack && phraseChanged)
          || Boolean(variant.id !== previous?.variant.id);
        if (semanticTrack && allowAnchoredPhraseVariant) {
          // Keep the cue anchored while allowing an actual phrase boundary to
          // pick a fresh same-family hold. Word ticks never take this path.
          semanticTrack.variant = variant;
          semanticTrack.intent = intent;
        }
        const articulationAccent = speechAccentForTick(
          cueForTicks,
          chosenTick,
          punctuation,
          `${input.cue?.turnId ?? "speech"}:${input.cue?.id ?? "ticks"}:${variant.id}:${intent}`,
        );
        const source = phraseChanged ? "phrase" : "word";
        const explicitGesture = semanticTrack?.cue.gesture ?? input.cue?.gesture;
        const currentGesture: GesturePose = {
          headX: this.expression.headX,
          headY: this.expression.headY,
          headZ: this.expression.headZ,
          x: this.body.x,
          y: this.body.y,
          scale: this.body.scale,
          squashX: this.body.squashX,
          squashY: this.body.squashY,
        };
        const priorGestureElapsed = previous ? time - previous.gestureStartedAt : 0;
        const authoredGestureFinished = Boolean(
          semanticTrack
          && semanticTrack.gestureExplicit
          && explicitGesture !== undefined
          && explicitGesture !== "still"
          && priorGestureElapsed >= gestureDuration(explicitGesture),
        );
        // A phrase boundary is the only place an anchored speech cue may
        // hand the head/body to a fresh delivery beat. Explicit `still` is a
        // real instruction and remains still; word ticks keep the existing
        // gesture clock untouched.
        const phraseGestureRetarget = Boolean(
          phraseChanged
          && previous
          && semanticTrack
          && explicitGesture !== "still"
          && (!semanticTrack.gestureExplicit || authoredGestureFinished),
        );
        const selectedPhraseGesture = semanticTrack
          ? semanticTrack.gestureExplicit && !authoredGestureFinished
            ? explicitGesture ?? reactionGesture(cueForTicks)
            : !previous && !semanticTrack.gestureExplicit
              ? reactionGesture(cueForTicks)
              : phraseGesture(cueForTicks, semanticTrack.intent, variant, phraseTick)
          : previous?.gesture ?? phraseGesture(cueForTicks, intent, variant, phraseTick);
        // Only a new anchored phrase may retarget the base pose or gesture.
        // Every word reuses that state and only replaces the accent clock.
        const gestureNeedsRetarget = !previous || phraseGestureRetarget || (phraseNeedsRetarget && !semanticTrack);
        const gesture = gestureNeedsRetarget
          ? (semanticTrack?.cue.gesture === "still" ? "still" : selectedPhraseGesture)
          : previous?.gesture ?? selectedPhraseGesture;
        const gestureStartedAt = gestureNeedsRetarget || !previous ? time : previous.gestureStartedAt;
        const gestureStart = gestureNeedsRetarget || !previous ? currentGesture : previous.gestureStart;
        const phraseLabel = source === "phrase" ? `phrase-${phraseTick}` : `word-${Math.abs(Math.trunc(wordTick))}`;
        const phraseOwnsGesture = Boolean(
          previous?.phraseOwnsGesture
          || (semanticTrack && (!semanticTrack.gestureExplicit || phraseGestureRetarget)),
        );
        this.microBeat = previous && !phraseNeedsRetarget && !phraseGestureRetarget
          ? {
            ...previous,
            // Keep the base eye tween and head gesture clock intact while the
            // word accent gets a fresh, audible onset.
            accent: articulationAccent,
            accentStartedAt: time,
            source,
            label: phraseLabel,
            intent: semanticTrack?.intent ?? previous.intent,
          }
          : {
            face: cueForTicks,
            gesture,
            accent: articulationAccent,
            startedAt: time,
            accentStartedAt: time,
            startPose: this.visiblePortrait(),
            startGesture: currentGesture,
            duration: variantDuration(variant),
            source,
            label: phraseLabel,
            variant,
            intent: semanticTrack?.intent ?? intent,
            variantStartedAt: time,
            gestureStartedAt,
            gestureStart,
            phraseOwnsGesture,
          };
        if (semanticTrack) this.currentIntent = semanticTrack.intent;
        this.lastMicroBeatAt = time;
      }
      if (input.activity.phraseTick !== undefined) this.lastPhraseTick = input.activity.phraseTick;
      if (input.activity.wordTick !== undefined) this.lastWordTick = input.activity.wordTick;
      this.tickCueId = input.cue?.id ?? this.tickCueId;
    }

    const idle = this.updateIdle(input, time);
    let target = poseOf(input.expression);
    let gestureTarget = { ...REST_GESTURE };
    let activeGesture: CharacterGesture = "still";
    let activeAccent: CharacterAccent | undefined;
    let accentElapsed = 0;
    let accentOpennessTarget = 1;
    let articulationAccent: CharacterAccent | undefined;
    let articulationAccentElapsed = 0;
    let activeVariant = this.currentVariant;
    let activeIntent = this.currentIntent;
    let beat = talking ? "speaking" : listening ? "listening" : "rest";
    // Fast word/phrase accents may replace the eyes, but an explicit speech
    // cue owns the physical head/body gesture through its authored tail. This
    // prevents a 240ms word clock from repeatedly restarting a tilt at its
    // anticipation keyframe.
    let authoredSpeechGestureActive = false;
    const track = this.track;
    if (!track || track.cue.expression !== input.expression) {
      const semantic = semanticExpressionFor(input.expression);
      if (this.currentVariant.expression !== semantic) {
        activeIntent = intentForCue(input.cue);
        activeVariant = this.chooseVariant(input.expression, activeIntent, undefined, `expression:${semantic}:${time}`);
      }
    }
    if (track && track.cue.expression === input.expression) {
      if (track.startedAt === null && (track.cue.source === "user" || (talking && input.activity.output > 0.025))) {
        track.startedAt = time;
        track.startedBeforeSpeech = !talking;
        track.startPose = this.visiblePortrait();
        track.startGesture = {
          headX: this.expression.headX, headY: this.expression.headY, headZ: this.expression.headZ,
          ...this.body,
        };
      }
      if (track.startedAt !== null && (talking || track.cue.source === "user")) {
        const elapsed = time - track.startedAt;
        let from = track.beats[0];
        let to = from;
        for (const candidate of track.beats) {
          to = candidate;
          if (candidate.at > elapsed) break;
          from = candidate;
        }
        const progress = from === to ? 1 : smooth((elapsed - from.at) / (to.at - from.at));
        let staged: Portrait;
        if (from === track.beats[0] && track.startPose && from !== to) {
          // The physical spring below already owns a continuous entrance
          // from the visible pose and velocity. A second 120–150ms tween in
          // front of it delayed recognition, especially on a short reply.
          // Aim at the first readable face immediately; do not snap the
          // rendered geometry or prematurely travel toward beat two.
          staged = poseOf(from.face, from.smile, track.variant);
        } else {
          const fromPose = from === track.beats[0] && track.startPose
            ? track.startPose
            : poseOf(from.face, from.smile, track.variant);
          staged = blendPortrait(fromPose, poseOf(to.face, to.smile, track.variant), progress);
        }
        // A completed user turn is already a valid semantic event. Start
        // from the live pose, but let its meaning become legible immediately
        // instead of spending the first half-second in an attentive prelude.
        // The spring still preserves continuity and velocity at cue arrival.
        const semanticBlendMax = track.cue.source === "user"
          ? 0.92 + unit(track.cue.intensity) * 0.08
          : 0.68 + unit(track.cue.intensity) * 0.32;
        // The first spoken frame inherits the already-rendered recognition
        // pose. Let the semantic silhouette enter over the same short physical
        // handoff instead of asking the spring to jump toward 70–100% of it
        // immediately after pre-audio recognition.
        const entrance = track.startedBeforeSpeech && track.startPose
          ? smooth(Math.min(1, Math.max(0, elapsed) / 170))
          : 1;
        const semanticBlend = semanticBlendMax * entrance;
        const cueOrigin = track.startPose && elapsed < 170 ? track.startPose : poseOf("attentive", 0, track.variant);
        target = blendPortrait(cueOrigin, staged, semanticBlend);
        activeVariant = track.variant;
        activeIntent = track.intent;
        const authoredSpeechGesture = track.cue.kind === "speech" && track.gestureExplicit
          ? track.cue.gesture
          : undefined;
        authoredSpeechGestureActive = authoredSpeechGesture !== undefined
          && elapsed <= gestureDuration(authoredSpeechGesture);
        if (authoredSpeechGestureActive || authoredSpeechGesture === undefined || track.cue.kind !== "speech") {
          // Explicit reaction gestures matter too. In particular, the
          // gallery's Present/still pose must not silently run a head tilt.
          activeGesture = authoredSpeechGesture ?? (track.gestureExplicit ? track.cue.gesture : undefined) ?? reactionGesture(track.cue.expression);
          gestureTarget = sampleGesture(activeGesture, elapsed, track.startGesture ?? REST_GESTURE);
        } else {
          // The finite authored gesture has reached its settle tail. Return to
          // rest through the spring; a later local microbeat may own the head.
          activeGesture = "still";
          gestureTarget = { ...REST_GESTURE };
        }
        // An explicit model-selected accent is the primary semantic track;
        // the variant is only the fallback when no accent was authored.
        activeAccent = track.cue.accent ?? track.variant.accent ?? reactionAccent(track.cue.expression);
        accentElapsed = elapsed;
        beat = progress > 0.5 ? to.label : from.label;
        const userReaction = track.cue.source === "user";
        const effectActivityPresent = userReaction
          ? input.phase !== "idle" && input.phase !== "error"
          : talking && input.activity.output > 0.035;
        const effectLead = userReaction ? 120 : 220;
        const canEffect = !(input.effectPreview && input.previewEffect) && effectActivityPresent && elapsed >= effectLead && elapsed < 2700
          && track.cue.effect !== "none" && track.cue.confidence >= 0.8 && track.cue.intensity >= 0.55
          && (input.effectPreview || reactionEffectFits(track.cue.expression, track.cue.effect))
          && !this.effectTurns.has(track.cue.turnId)
          && (input.effectPreview || time - this.lastEffectAt > EFFECT_COOLDOWN_MS);
        if (canEffect) {
          this.effect = { id: track.cue.turnId + ":effect", kind: track.cue.effect as ActiveEffect["kind"], startedAt: time, strength: track.cue.intensity };
          this.effectTurns.add(track.cue.turnId);
          if (this.effectTurns.size > 64) this.effectTurns.delete(this.effectTurns.values().next().value!);
          this.lastEffectAt = time;
        }
      }
    }

    if (idle) {
      const progress = smooth(idle.elapsed / 320);
      target = blendPortrait(idle.startPose, poseOf(idle.beat.face), progress);
      activeGesture = idle.beat.gesture;
      gestureTarget = sampleGesture(idle.beat.gesture, idle.elapsed, idle.startGesture);
      activeAccent = idle.beat.accent;
      accentElapsed = idle.elapsed;
      beat = idle.beat.label;
    }

    // The phrase beat owns the base silhouette. It stays latched until the
    // cue/phrase changes, so a word timestamp cannot restart the eye tween or
    // pull the head back to an anticipation keyframe. Word timestamps only
    // replace the short articulation accent below.
    if (this.microBeat && talking) {
      const elapsed = time - this.microBeat.startedAt;
      const hasAnchoredTrack = Boolean(track && track.cue.expression === input.expression);
      if (!hasAnchoredTrack) {
        // A transcript-only stream has no semantic track, so its phrase beat
        // owns the eye target. It still gets one short entry, then holds.
        const progress = smooth(elapsed / Math.max(120, this.microBeat.variant.entryMs));
        target = blendPortrait(
          this.microBeat.startPose,
          poseOf(this.microBeat.face, this.microBeat.smile, this.microBeat.variant),
          progress,
        );
        activeVariant = this.microBeat.variant;
        activeIntent = this.microBeat.intent;
      }
      // After the initial authored gesture lands, the phrase keeps ownership
      // of its follow-through across word ticks. Word events never restart it.
      if (!authoredSpeechGestureActive && (!hasAnchoredTrack || this.microBeat.phraseOwnsGesture)) {
        activeGesture = this.microBeat.gesture;
        gestureTarget = sampleGesture(
          this.microBeat.gesture,
          time - this.microBeat.gestureStartedAt,
          this.microBeat.gestureStart,
        );
      }
      // Keep the model-selected cue accent as the primary semantic event;
      // this tick accent is only a smaller, fast audio articulation layer.
      articulationAccent = this.microBeat.accent;
      articulationAccentElapsed = time - this.microBeat.accentStartedAt;
      beat = this.microBeat.label;
    }

    if (activeAccent) {
      const accented = applyCharacterAccent(
        target.expression,
        target.smile,
        activeAccent,
        accentElapsed,
        (0.65 + unit(input.cue?.intensity ?? 0.9) * 0.35) * (input.reducedMotion ? 0.22 : 1),
      );
      target = { ...target, expression: accented.expression, smile: accented.smile };
      accentOpennessTarget = accented.openness;
    }
    if (articulationAccent && articulationAccent !== activeAccent) {
      const articulated = applyCharacterAccent(
        target.expression,
        target.smile,
        articulationAccent,
        articulationAccentElapsed,
        (0.2 + unit(input.cue?.intensity ?? 0.9) * 0.12) * (input.reducedMotion ? 0.22 : 1),
        "speech",
      );
      target = { ...target, expression: articulated.expression, smile: articulated.smile };
      accentOpennessTarget = Math.min(accentOpennessTarget, articulated.openness);
    }

    const onset = Math.max(0, this.energy - this.sustainedEnergy);
    const hearsSyllables = input.activity.syllableTick !== undefined;
    if (talking && !hearsSyllables && onset > 0.11 && time - this.lastAccentAt > 360) {
      this.lastAccentAt = time;
      this.accentStrength = unit(onset * 2.6);
    }
    const accentAge = time - this.lastAccentAt;
    const accentEnvelope = accentAge < 120 ? smooth(accentAge / 120) : 1 - smooth((accentAge - 120) / 300);
    const stress = this.accentStrength * accentEnvelope * this.speechPresence * this.softness * this.motionScale;
    const speech = this.energy * this.speechPresence * this.softness * this.motionScale;
    const attention = this.listeningPresence * this.energy * 0.07 * this.motionScale;

    // Accents modify a readable emotional silhouette. They don't select moods,
    // move the whole head, or run when the audio is silent.
    target.expression.heightLeft += speech * 4 + stress * 10 + attention * 10;
    target.expression.heightRight += speech * 3 + stress * 8 + attention * 8;
    target.expression.widthLeft += stress * 2.5;
    target.expression.widthRight += stress * 1.5;
    target.expression.leftAngle -= stress * 2;
    target.expression.rightAngle += stress * 2;
    target.smile *= 1 - stress * 0.1;
    target.expression.headX = gestureTarget.headX * this.motionScale;
    target.expression.headY = gestureTarget.headY * this.motionScale;
    target.expression.headZ = gestureTarget.headZ * this.motionScale;

    for (const axis of ["x", "y", "scale", "squashX", "squashY"] as const) {
      const rest = axis === "scale" || axis === "squashX" || axis === "squashY" ? 1 : 0;
      const targetValue = rest + (gestureTarget[axis] - rest) * this.motionScale;
      [this.body[axis], this.bodyVelocities[axis]] = springStep(this.body[axis], this.bodyVelocities[axis], targetValue, dt, axis === "squashX" || axis === "squashY" ? 18 : 13);
    }

    for (const field of expressionFields) {
      const [value, velocity] = springStep(this.expression[field], this.velocities.get(field) ?? 0, target.expression[field], dt, 16);
      this.expression[field] = value;
      this.velocities.set(field, velocity);
    }
    [this.smile, this.smileVelocity] = springStep(this.smile, this.smileVelocity, target.smile, dt, 15);
    [this.accentOpenness, this.accentOpennessVelocity] = springStep(this.accentOpenness, this.accentOpennessVelocity, accentOpennessTarget, dt, 24);

    if (!input.reducedMotion && time >= this.nextBlinkAt && this.blinkStartedAt === null && this.energy < 0.1) this.blinkStartedAt = time;
    let blink = 0;
    if (this.blinkStartedAt !== null) {
      const progress = (time - this.blinkStartedAt) / 300;
      if (progress >= 1) {
        this.blinkStartedAt = null;
        this.nextBlinkAt = time + [5300, 6900, 4600, 7800][this.blinkIndex++ % 4];
      } else blink = Math.sin(Math.PI * progress) ** 2;
    }
    // A friendly mark can accompany genuine relief. Do
    // not retire that earned warm beat merely because its semantic expression
    // is gentle; other effects still disappear immediately on a soft/error
    // transition so celebrations cannot leak into vulnerable moments.
    const semanticExpression = input.cue?.expression ?? input.expression;
    const cueIsIncompatible = input.cue !== undefined && input.cue !== null
      && !reactionEffectFits(input.cue.expression, this.effect?.kind ?? "none");
    const phaseIsIncompatible = !reactionEffectFits(input.expression, this.effect?.kind ?? "none");
    if (this.effect && (input.phase === "idle" || input.phase === "error" || (!input.effectPreview && (cueIsIncompatible || phaseIsIncompatible || !reactionEffectFits(semanticExpression, this.effect.kind))))) {
      this.effect.retiringAt ??= time;
    }
    if (this.effect && (time - this.effect.startedAt > EFFECT_DURATION || (this.effect.retiringAt !== undefined && time - this.effect.retiringAt > 180))) this.effect = null;

    // Syllable pulses sit on top of the sprung pose rather than inside its
    // target, so the spring cannot smear a 45 ms rise into a 150 ms drift.
    // Every syllable lifts the eyes slightly; stressed ones also dip the head
    // and stretch the body, like a nod on the important word.
    let pulse = 0;
    let stressPulse = 0;
    for (const syllable of this.syllablePulses) {
      const shape = syllableEnvelope(time - syllable.at);
      pulse += shape * (0.45 + 0.55 * syllable.strength);
      stressPulse += shape * Math.max(0, syllable.strength - 0.45) / 0.55;
    }
    const gain = this.speechPresence * this.softness * this.motionScale;
    pulse = Math.min(1.2, pulse) * gain;
    stressPulse = Math.min(1, stressPulse) * gain;
    const shown = { ...this.expression };
    shown.heightLeft += pulse * 9;
    shown.heightRight += pulse * 8;
    shown.widthLeft -= pulse * 1.2;
    shown.widthRight -= pulse * 1.2;
    shown.headX -= stressPulse * 2.6;
    const shownBody = { ...this.body };
    shownBody.squashY += pulse * 0.022 + stressPulse * 0.012;
    shownBody.squashX -= pulse * 0.012;
    shownBody.y -= pulse * 1.4;

    return {
      expression: shown,
      body: shownBody,
      openness: (1 - blink) * unit(this.accentOpenness),
      energy: this.energy,
      speech,
      stress,
      smile: unit(this.smile),
      beat,
      gesture: activeGesture,
      accent: activeAccent ?? "none",
      variantId: activeVariant.id,
      intent: activeIntent,
      wordTick: input.activity.wordTick,
      phraseTick: input.activity.phraseTick,
      effect: this.effect,
    };
  }
}

