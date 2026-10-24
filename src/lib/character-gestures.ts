import type { AvatarExpression } from "../types";

export type CharacterGesture = "still" | "tilt-left" | "tilt-right" | "nod" | "lift" | "lean-in" | "settle";
export const CHARACTER_GESTURES: readonly CharacterGesture[] = [
  "still",
  "tilt-left",
  "tilt-right",
  "nod",
  "lift",
  "lean-in",
  "settle",
] as const;
export type GesturePose = {
  headX: number;
  headY: number;
  headZ: number;
  x: number;
  y: number;
  scale: number;
  /** Optional squash/stretch keeps the circle feeling physical on accents. */
  squashX: number;
  squashY: number;
};
type Keyframe = GesturePose & { at: number };

/**
 * Deliberately generous acting limits.  These are animation-space values, not
 * camera movement: the body still remains one coherent object while a beat
 * can land hard enough to read as a head gesture at the small preview size.
 */
export const CHARACTER_GESTURE_LIMITS = {
  head: 34,
  body: 24,
  scaleMin: 0.9,
  scaleMax: 1.18,
} as const;

export const REST_GESTURE: GesturePose = {
  headX: 0,
  headY: 0,
  headZ: 0,
  x: 0,
  y: 0,
  scale: 1,
  squashX: 1,
  squashY: 1,
};
// The default direction is intentionally theatrical. Scale the authored
// endpoints, never the captured visible start pose on a mid-gesture retarget.
// A small white character needs an unambiguously visible beat; these bounds
// keep it expressive without allowing a gesture to become an orbit or a
// camera move.
const frame = (at: number, pose: Partial<GesturePose>): Keyframe => ({
  at,
  headX: Math.max(-CHARACTER_GESTURE_LIMITS.head, Math.min(CHARACTER_GESTURE_LIMITS.head, (pose.headX ?? 0) * 2.7)),
  headY: Math.max(-CHARACTER_GESTURE_LIMITS.head, Math.min(CHARACTER_GESTURE_LIMITS.head, (pose.headY ?? 0) * 2.7)),
  headZ: Math.max(-CHARACTER_GESTURE_LIMITS.head, Math.min(CHARACTER_GESTURE_LIMITS.head, (pose.headZ ?? 0) * 2.8)),
  x: Math.max(-CHARACTER_GESTURE_LIMITS.body, Math.min(CHARACTER_GESTURE_LIMITS.body, (pose.x ?? 0) * 4.2)),
  y: Math.max(-CHARACTER_GESTURE_LIMITS.body, Math.min(CHARACTER_GESTURE_LIMITS.body, (pose.y ?? 0) * 4.2)),
  scale: Math.max(CHARACTER_GESTURE_LIMITS.scaleMin, Math.min(CHARACTER_GESTURE_LIMITS.scaleMax, 1 + ((pose.scale ?? 1) - 1) * 4)),
  squashX: Math.max(0.92, Math.min(1.12, pose.squashX ?? 1)),
  squashY: Math.max(0.92, Math.min(1.12, pose.squashY ?? 1)),
});

// A gesture has a reason, a single accent, and a resting endpoint. These are
// sentence gestures, never a clock-driven head orbit or an audio-volume wiggle.
const gestures: Record<CharacterGesture, readonly Keyframe[]> = {
  still: [frame(400, {})],
  "tilt-left": [
    frame(120, { headX: -1.4, headZ: -3.6, x: -1.2, y: 0.7, squashX: 1.02, squashY: 0.98 }),
    frame(330, { headX: -3.2, headZ: -12, x: -5.6, y: 2.5, squashX: 1.05, squashY: 0.95 }),
    frame(760, { headX: -3.2, headZ: -12, x: -5.6, y: 2.5, squashX: 1.05, squashY: 0.95 }),
    frame(930, { headX: -2.2, headZ: -9, x: -4.2, y: 1.8, squashX: 1.03, squashY: 0.97 }),
    frame(1110, { headX: -1.2, headZ: -5.5, x: -2.2, y: 0.8, squashX: 1.02, squashY: 0.98 }),
    frame(1560, { headZ: -2, x: -0.5 }),
  ],
  "tilt-right": [
    frame(110, { headY: 1.4, headZ: 3.6, x: 1.2, y: -0.7, squashX: 1.02, squashY: 0.98 }),
    frame(300, { headY: 3.3, headZ: 12, x: 5.6, y: -2.3, squashX: 1.05, squashY: 0.95 }),
    frame(720, { headY: 3.3, headZ: 12, x: 5.6, y: -2.3, squashX: 1.05, squashY: 0.95 }),
    frame(900, { headY: 2.1, headZ: 9, x: 4.1, y: -1.8, squashX: 1.03, squashY: 0.97 }),
    frame(1080, { headY: 1.2, headZ: 5.5, x: 2.2, y: -0.8, squashX: 1.02, squashY: 0.98 }),
    frame(1510, { headZ: 2, x: 0.5 }),
  ],
  nod: [
    // A tiny lift-back is the anticipation; the downbeat then has a clear
    // compress/stretch rhythm instead of reading as a single rigid nod.
    frame(72, { headX: -2.4, y: -1.8, scale: 0.99, squashX: 1.04, squashY: 0.96 }),
    frame(150, { headX: -3.8, y: -2.8, scale: 0.98, squashX: 1.06, squashY: 0.94 }),
    frame(300, { headX: 7.4, y: 6.2, scale: 1.015, squashX: 0.95, squashY: 1.1 }),
    frame(410, { headX: 6.2, y: 5.2, scale: 1.01, squashX: 0.98, squashY: 1.05 }),
    frame(520, { headX: -4.2, y: -3.7, scale: 0.992, squashX: 1.045, squashY: 0.955 }),
    frame(650, { headX: -2.7, y: -2.1, scale: 0.997, squashX: 1.025, squashY: 0.975 }),
    frame(760, { headX: 6.5, y: 5.2, scale: 1.01, squashX: 0.97, squashY: 1.07 }),
    frame(900, { headX: 4.1, y: 3.2, scale: 1.005, squashX: 0.99, squashY: 1.03 }),
    frame(1060, { headX: 2.2, y: 1.6, scale: 1.002, squashX: 1.02, squashY: 0.98 }),
    frame(1440, {}),
  ],
  lift: [
    // Anime-like punctuation comes from a quick squash before the lift,
    // followed by a soft rebound. The body remains inside the same authored
    // travel limits; only the timing and silhouette give it more life.
    frame(78, { headX: 1.8, y: 2.1, scale: 0.985, squashX: 1.05, squashY: 0.95 }),
    frame(160, { headX: 2.6, y: 2.8, scale: 0.975, squashX: 1.08, squashY: 0.93 }),
    frame(270, { headX: -8.2, y: -7.2, headZ: 3.2, scale: 1.055, squashX: 0.94, squashY: 1.1 }),
    frame(420, { headX: -7.1, y: -6.1, headZ: 2.4, scale: 1.048, squashX: 0.955, squashY: 1.075 }),
    frame(590, { headX: -6.4, y: -5.2, headZ: 1.8, scale: 1.045, squashX: 0.95, squashY: 1.075 }),
    frame(700, { headX: -5.1, y: -4.1, headZ: 1.1, scale: 1.03, squashX: 0.975, squashY: 1.04 }),
    frame(780, { headX: -4.4, y: -3.5, headZ: 0.8, scale: 1.025, squashX: 0.975, squashY: 1.04 }),
    frame(890, { headX: -2.5, y: -1.8, scale: 1.015, squashX: 0.99, squashY: 1.02 }),
    frame(1270, {}),
  ],
  "lean-in": [
    // Leaning in gets a little recoil first, then an open, forward stretch;
    // the small recoil after the hold keeps it conversational instead of
    // locking the whole character in one pose.
    frame(84, { headX: -1.4, headZ: -1.2, x: -1.3, y: 1.1, scale: 0.985, squashX: 1.05, squashY: 0.95 }),
    frame(180, { headX: -2.4, headZ: -2.2, x: -2.2, y: 1.7, scale: 0.975, squashX: 1.08, squashY: 0.93 }),
    frame(400, { headX: 6.4, headZ: 8.2, x: 5.3, y: -3.4, scale: 1.055, squashX: 1.07, squashY: 0.94 }),
    frame(560, { headX: 7.1, headZ: 8.8, x: 5.9, y: -3.8, scale: 1.06, squashX: 1.08, squashY: 0.93 }),
    frame(720, { headX: 6.6, headZ: 8.3, x: 5.5, y: -3.5, scale: 1.055, squashX: 1.065, squashY: 0.945 }),
    frame(920, { headX: 6.4, headZ: 8.2, x: 5.3, y: -3.4, scale: 1.055, squashX: 1.07, squashY: 0.94 }),
    frame(1080, { headX: 5.1, headZ: 6.2, x: 4.2, y: -2.8, scale: 1.04, squashX: 1.05, squashY: 0.96 }),
    frame(1230, { headX: 2.3, headZ: 2.8, x: 1.8, y: -1.2, scale: 1.02, squashX: 1.02, squashY: 0.98 }),
    frame(1660, { headX: 0.5, headZ: 0.5 }),
  ],
  settle: [
    frame(120, { headX: 2.1, headZ: -2.1, y: 2.1, scale: 0.992, squashX: 1.02, squashY: 0.98 }),
    frame(400, { headX: 6.1, headZ: -7.2, y: 6.2, scale: 0.94, squashX: 1.07, squashY: 0.94 }),
    frame(920, { headX: 6.1, headZ: -7.2, y: 6.2, scale: 0.94, squashX: 1.07, squashY: 0.94 }),
    frame(1100, { headX: 3.3, headZ: -4, y: 3.2, scale: 0.97, squashX: 1.04, squashY: 0.96 }),
    frame(1250, { headX: 1.7, headZ: -2.2, y: 1.7, scale: 0.985, squashX: 1.02, squashY: 0.98 }),
    frame(1700, {}),
  ],
};

/**
 * Authored gesture tails are finite.  A speech cue can own the head/body
 * through this tail while faster word accents change only the eyes; after the
 * tail, a later local beat is allowed to take over from the settled pose.
 */
export const CHARACTER_GESTURE_DURATIONS: Readonly<Record<CharacterGesture, number>> = {
  still: 400,
  "tilt-left": 1560,
  "tilt-right": 1510,
  nod: 1440,
  lift: 1270,
  "lean-in": 1660,
  settle: 1700,
};

export function gestureDuration(gesture: CharacterGesture): number {
  return CHARACTER_GESTURE_DURATIONS[gesture];
}

export function reactionGesture(expression: AvatarExpression): CharacterGesture {
  if (["delighted", "joyful", "excited", "surprised", "proud"].includes(expression)) return "lift";
  if (["concerned", "sad", "shy"].includes(expression)) return "tilt-left";
  if (["curious", "confused"].includes(expression)) return "lean-in";
  if (["playful", "amused", "skeptical"].includes(expression)) return "tilt-right";
  if (["relieved", "sleepy"].includes(expression)) return "settle";
  return "still";
}

export function sampleGesture(gesture: CharacterGesture, elapsed: number, start: GesturePose): GesturePose {
  let from: Keyframe = { ...start, at: 0 };
  let to = from;
  for (const keyframe of gestures[gesture]) {
    to = keyframe;
    if (keyframe.at > elapsed) break;
    from = keyframe;
  }
  const t = from === to ? 1 : Math.max(0, Math.min(1, (elapsed - from.at) / (to.at - from.at)));
  const blend = t * t * (3 - 2 * t);
  const pose = { ...REST_GESTURE };
  for (const key of Object.keys(pose) as Array<keyof GesturePose>) pose[key] = from[key] + (to[key] - from[key]) * blend;
  return pose;
}
