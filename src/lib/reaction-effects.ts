import type { ReactionEffect } from "./reaction-cues";

export type ActiveEffect = {
  id: string;
  kind: Exclude<ReactionEffect, "none">;
  startedAt: number;
  strength: number;
  retiringAt?: number;
};

export type EffectParticle = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
  color: string;
  shape:
    | "confetti"
    | "sparkle"
    | "friendly-mark"
    | "arc"
    | "question"
    | "question-dot"
    | "idea"
    | "idea-ray"
    | "pop-ring"
    | "pop-ray"
    | "laugh-mark"
    | "anger-mark";
};

export const EFFECT_PARTICLE_COUNT = 4;
export const EFFECT_DURATION = 2000;
const palette = ["#e1caff", "#bce8aa", "#ffe0a3", "#f8aaa3", "#9ed7ff"];
const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const ease = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };

type ConfettiSeed = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  rotation: number;
  spin: number;
  scale: number;
  shape: "confetti" | "arc";
};

// Staggered seeds make a win read as a little burst, rather than four copies
// of the same rectangle drifting on a shared line. The shallow arc is a
// single attached celebration mark; it keeps the effect legible without
// turning the character into a confetti cannon. They are deterministic so
// replaying a turn produces the same physical moment.
const confettiSeeds: readonly ConfettiSeed[] = [
  { x: -88, y: -116, vx: -26, vy: -46, gravity: 58, rotation: -18, spin: -250, scale: 0.86, shape: "confetti" },
  { x: 0, y: -126, vx: 0, vy: -10, gravity: 20, rotation: 0, spin: 18, scale: 1.08, shape: "arc" },
  { x: 88, y: -116, vx: 26, vy: -48, gravity: 60, rotation: 9, spin: -330, scale: 0.92, shape: "confetti" },
  { x: -36, y: -138, vx: -10, vy: -58, gravity: 74, rotation: 22, spin: 300, scale: 0.78, shape: "confetti" },
];

type SparkleSeed = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  rotation: number;
  spin: number;
  scale: number;
};

// Sparkles radiate from a compact point and breathe once. The staggered
// radius/scale makes surprise or a playful punchline feel different from the
// wider confetti celebration.
const sparkleSeeds: readonly SparkleSeed[] = [
  { x: -8, y: -120, dx: -28, dy: -8, rotation: 0, spin: 160, scale: 0.86 },
  { x: 8, y: -118, dx: 4, dy: -20, rotation: 20, spin: -210, scale: 1.08 },
  { x: 24, y: -118, dx: 28, dy: -8, rotation: -15, spin: 240, scale: 0.92 },
  { x: 0, y: -120, dx: 0, dy: 8, rotation: 45, spin: -130, scale: 0.66 },
];

type FriendlySeed = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

// A small golden greeting fan, not affection or a floating heart. The legacy
// "heart" cue stays wire-compatible with saved performances; its rendering
// and meaning are now strictly friendly. One pop, then a quiet settle.
const friendlySeed: FriendlySeed = {
  x: 70,
  y: -80,
  rotation: 12,
  scale: 0.98,
};

type QuestionSeed = {
  x: number;
  y: number;
  leanX: number;
  settleY: number;
  rotation: number;
  scale: number;
  shape: "question" | "question-dot";
};

// One stable inquiry glyph, split only into its curve and dot so the dot can
// arrive with the curve. Both pieces share the same deliberate lean; there is
// no rotating question-mark cloud or random orbit.
const questionSeeds: readonly QuestionSeed[] = [
  { x: 65, y: -90, leanX: -9, settleY: 3, rotation: -11, scale: 1.02, shape: "question" },
  { x: 66, y: -90, leanX: -9, settleY: 3, rotation: -11, scale: 1.02, shape: "question-dot" },
];

type AngerSeed = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

// A single warm, bubbly forehead mark. It is deliberately attached to one
// corner of the head: the silhouette says "that is frustrating" without
// turning irritation into a noisy particle cloud or an ambient loop.
const angerSeed: AngerSeed = {
  x: 70,
  y: -96,
  rotation: -18,
  scale: 1,
};

type IdeaSeed = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  delay: number;
  shape: "idea" | "idea-ray";
};

// The bulb is one coherent mark; three short rays reveal in a small cascade,
// which reads as insight rather than another four-point sparkle.
const ideaSeeds: readonly IdeaSeed[] = [
  { x: 0, y: -104, rotation: 0, scale: 1.02, delay: 0, shape: "idea" },
  { x: 0, y: -128, rotation: 0, scale: 0.82, delay: 0.05, shape: "idea-ray" },
  { x: -28, y: -116, rotation: -58, scale: 0.72, delay: 0.12, shape: "idea-ray" },
  { x: 28, y: -116, rotation: 58, scale: 0.72, delay: 0.19, shape: "idea-ray" },
];

type PopSeed = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  delay: number;
  shape: "pop-ring" | "pop-ray";
};

// A surprise pop is a single readable punctuation mark: one expanding ring
// and three short rays. It gives a surprised face a tangible beat without
// becoming another confetti shower.
const popSeeds: readonly PopSeed[] = [
  { x: 0, y: -122, rotation: 0, scale: 0.92, delay: 0, shape: "pop-ring" },
  { x: -23, y: -124, rotation: -62, scale: 0.7, delay: 0.06, shape: "pop-ray" },
  { x: 0, y: -145, rotation: 0, scale: 0.66, delay: 0.1, shape: "pop-ray" },
  { x: 23, y: -124, rotation: 62, scale: 0.7, delay: 0.14, shape: "pop-ray" },
];

type LaughSeed = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  dx: number;
  dy: number;
};

// Laugh marks are small, curved punctuation around the face. They rise and
// settle together, so amusement reads as a contained reaction instead of a
// generic sparkle burst.
const laughSeeds: readonly LaughSeed[] = [
  { x: -34, y: -119, rotation: -30, scale: 0.78, dx: -10, dy: -8 },
  { x: -12, y: -132, rotation: -8, scale: 0.92, dx: -3, dy: -13 },
  { x: 14, y: -132, rotation: 8, scale: 0.92, dx: 4, dy: -13 },
  { x: 36, y: -119, rotation: 30, scale: 0.78, dx: 11, dy: -8 },
];

// Deterministic variations belong to this one reaction, never an ambient loop.
export function sampleEffect(effect: ActiveEffect | null, time: number, reduced = false): EffectParticle[] {
  if (!effect) return [];
  const startedAt = Number.isFinite(effect.startedAt) ? effect.startedAt : 0;
  const now = Number.isFinite(time) ? time : startedAt;
  const t = Math.max(0, (now - startedAt) / 1000);
  if (t > EFFECT_DURATION / 1000) return [];
  const retirement = effect.retiringAt === undefined || !Number.isFinite(effect.retiringAt)
    ? 1 : 1 - clamp((now - effect.retiringAt) / 180);
  const enter = ease(t / 0.14);
  const fade = enter * (1 - ease((t - 1.2) / 0.62)) * retirement;
  const strength = clamp(effect.strength);
  const travel = reduced ? 0 : 1;
  const kind = effect.kind as string;

  if (kind === "confetti") {
    return (reduced ? confettiSeeds.slice(0, 1) : confettiSeeds).map((seed, i) => {
      const fall = seed.gravity * t * t;
      const sway = Math.sin(Math.PI * clamp(t / 1.35) + i * 0.7) * (3 + i);
      return {
        x: seed.x + (seed.vx * t + sway) * travel,
        y: seed.y + (seed.vy * t + fall) * travel,
        rotation: reduced ? 0 : seed.rotation + seed.spin * t,
        scale: seed.scale * (0.86 + strength * 0.22) * (reduced ? 1 : enter),
        opacity: fade,
        color: palette[i % palette.length],
        shape: seed.shape,
      };
    });
  }

  if (kind === "sparkle") {
    const burst = ease(t / 0.2);
    const breathe = 0.82 + Math.sin(Math.PI * clamp((t - 0.08) / 1.05)) * 0.18;
    return (reduced ? sparkleSeeds.slice(0, 1) : sparkleSeeds).map((seed, i) => ({
      x: seed.x + seed.dx * burst * travel,
      y: seed.y + seed.dy * burst * travel,
      rotation: reduced ? 0 : seed.rotation + seed.spin * t,
      scale: seed.scale * (0.86 + strength * 0.22) * (reduced ? 1 : burst * breathe),
      opacity: fade * 0.94,
      color: palette[(i + 2) % palette.length],
      shape: "sparkle",
    }));
  }

  if (kind === "question") {
    const reveal = ease(t / 0.16);
    const settle = ease((t - 0.16) / 0.62);
    const lean = 1 - settle;
    // A full half-wave gives the punctuation a readable toy-like pop. It
    // rises once, eases into place, and never becomes ambient motion.
    const spring = reduced ? 0 : Math.sin(Math.PI * clamp((t - 0.08) / 0.7));
    const bounce = reduced ? 1 : 1 + 0.12 * spring;
    return questionSeeds.map((seed) => ({
      x: seed.x + seed.leanX * lean * travel + 3 * spring * travel,
      y: seed.y + seed.settleY * settle * travel - 5 * spring * travel,
      rotation: reduced ? 0 : seed.rotation * lean,
      scale: seed.scale * (0.86 + strength * 0.2) * (reduced ? 1 : reveal * bounce),
      opacity: fade * 0.96,
      color: "#efbb58",
      shape: seed.shape,
    }));
  }

  if (kind === "anger") {
    const reveal = ease(t / 0.12);
    const settle = ease((t - 0.16) / 0.46);
    const squash = reduced ? 1 : 1 + 0.08 * (1 - settle);
    const pop = reduced ? 1 : reveal * (1 + 0.18 * Math.sin(Math.PI * clamp((t - 0.08) / 0.5)));
    return [{
      x: angerSeed.x,
      y: angerSeed.y + (reduced ? 0 : -2 * reveal + 2 * settle),
      rotation: reduced ? 0 : angerSeed.rotation + 3 * Math.sin(Math.PI * clamp((t - 0.08) / 0.55)),
      scale: angerSeed.scale * (0.84 + strength * 0.2) * (reduced ? 1 : pop * squash),
      opacity: fade,
      color: "#f47f76",
      shape: "anger-mark",
    }];
  }

  if (kind === "idea") {
    return ideaSeeds.map((seed) => {
      const localT = reduced ? t : Math.max(0, t - seed.delay);
      const reveal = ease(localT / (seed.shape === "idea" ? 0.15 : 0.11));
      const spring = reduced ? 0 : Math.sin(Math.PI * clamp((localT - 0.06) / 0.68));
      const bounce = reduced ? 1 : 1 + 0.2 * spring;
      return {
        x: seed.x + (seed.shape === "idea" ? 1.5 : 0) * spring * travel,
        y: seed.y - 5 * spring * travel,
        rotation: reduced ? 0 : seed.rotation,
        scale: seed.scale * (0.86 + strength * 0.2) * (reduced ? 1 : reveal * bounce),
        opacity: fade * (seed.shape === "idea" ? 0.98 : reveal),
        color: seed.shape === "idea" ? "#f3c76b" : seed.delay > 0.1 ? "#eea36e" : "#f3c76b",
        shape: seed.shape,
      };
    });
  }

  if (kind === "pop") {
    return (reduced ? popSeeds.slice(0, 1) : popSeeds).map((seed) => {
      const localT = reduced ? t : Math.max(0, t - seed.delay);
      const reveal = ease(localT / (seed.shape === "pop-ring" ? 0.17 : 0.12));
      const settle = seed.shape === "pop-ring" ? 1 + 0.18 * Math.sin(Math.PI * clamp((localT - 0.15) / 0.72)) : 1;
      return {
        x: seed.x,
        y: seed.y,
        rotation: reduced ? 0 : seed.rotation,
        scale: seed.scale * (0.88 + strength * 0.2) * (reduced ? 1 : reveal * settle),
        opacity: fade * reveal,
        color: seed.shape === "pop-ring" ? "#ffe0a3" : palette[2],
        shape: seed.shape,
      };
    });
  }

  if (kind === "laugh") {
    const reveal = ease(t / 0.18);
    const breathe = 0.94 + Math.sin(Math.PI * clamp((t - 0.1) / 0.85)) * 0.1;
    return (reduced ? laughSeeds.slice(0, 1) : laughSeeds).map((seed) => ({
      x: seed.x + seed.dx * reveal * travel,
      y: seed.y + seed.dy * reveal * travel,
      rotation: reduced ? 0 : seed.rotation,
      scale: seed.scale * (0.88 + strength * 0.2) * (reduced ? 1 : reveal * breathe),
      opacity: fade * 0.88,
      color: palette[3],
      shape: "laugh-mark",
    }));
  }

  if (kind !== "heart") return [];

  const reveal = ease(t / 0.17);
  const settle = ease((t - 0.24) / 0.68);
  const spring = reduced ? 0 : Math.sin(Math.PI * clamp((t - 0.08) / 0.72));
  const pop = reduced ? 1 : reveal * (1 + 0.18 * spring);
  return [{
    x: friendlySeed.x + (reduced ? 0 : 3 * settle),
    y: friendlySeed.y + (reduced ? 0 : -4 * spring + 2 * settle),
    rotation: reduced ? 0 : friendlySeed.rotation - 8 * settle + 3 * spring,
    scale: friendlySeed.scale * (0.86 + strength * 0.2) * (reduced ? 1 : pop),
    opacity: fade * 0.94,
    color: "#efbb58",
    shape: "friendly-mark",
  }];
}
