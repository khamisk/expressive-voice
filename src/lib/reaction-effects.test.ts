import { describe, expect, it } from "vitest";
import {
  EFFECT_DURATION,
  sampleEffect,
  type ActiveEffect,
} from "./reaction-effects";

function effect(kind: ActiveEffect["kind"]): ActiveEffect {
  return { id: `${kind}-test`, kind, startedAt: 0, strength: 0.95 };
}

const pathBounds = {
  question: { minX: -13, maxX: 19, minY: -27, maxY: 15 },
  "question-dot": { minX: -3, maxX: 3, minY: 20, maxY: 26 },
  idea: { minX: -21, maxX: 21, minY: -18, maxY: 28 },
  "idea-ray": { minX: -2, maxX: 2, minY: -17, maxY: 1 },
  "friendly-mark": { minX: -25.25, maxX: 25.25, minY: -26.25, maxY: 2.25 },
  "pop-ring": { minX: -15, maxX: 15, minY: -15, maxY: 15 },
  "pop-ray": { minX: -2, maxX: 2, minY: -10, maxY: 10 },
  "laugh-mark": { minX: -13, maxX: 13, minY: -4, maxY: 6 },
  "anger-mark": { minX: -16, maxX: 16, minY: -14, maxY: 12 },
} as const;

// The avatar SVG opts into overflow: visible so a small reaction can hover
// just above the white 240-unit head. The conversation stage keeps a larger
// top gutter, so this is the deliberate drawing clearance around its 300-unit
// viewBox rather than a silent clipping workaround.
const EFFECT_DRAWING_EXTENT = 190;

function transformedBounds(particle: { x: number; y: number; rotation: number; scale: number; shape: keyof typeof pathBounds }) {
  const bounds = pathBounds[particle.shape];
  const radians = particle.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ].map(([x, y]) => ({
    x: particle.x + (x * cos - y * sin) * particle.scale,
    y: particle.y + (x * sin + y * cos) * particle.scale,
  }));
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function characterBounds(
  particle: { x: number; y: number; rotation: number; scale: number; shape: keyof typeof pathBounds },
  bodyRotation: number,
  bodyX: number,
  bodyY: number,
  bodyScale: number,
) {
  const bounds = pathBounds[particle.shape];
  const particleRadians = particle.rotation * Math.PI / 180;
  const bodyRadians = bodyRotation * Math.PI / 180;
  const particleCos = Math.cos(particleRadians);
  const particleSin = Math.sin(particleRadians);
  const bodyCos = Math.cos(bodyRadians);
  const bodySin = Math.sin(bodyRadians);
  const points = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ].map(([x, y]) => {
    const localX = particle.x + (x * particleCos - y * particleSin) * particle.scale;
    const localY = particle.y + (x * particleSin + y * particleCos) * particle.scale;
    return {
      x: bodyX + (localX * bodyCos - localY * bodySin) * bodyScale,
      y: bodyY + (localX * bodySin + localY * bodyCos) * bodyScale,
    };
  });
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

describe("one-shot reaction effects", () => {
  it("gives an earned win a staggered four-piece confetti burst", () => {
    const early = sampleEffect(effect("confetti"), 400);
    const late = sampleEffect(effect("confetti"), 1000);

    expect(early).toHaveLength(4);
    expect(early.map((particle) => particle.shape)).toContain("arc");
    expect(early.filter((particle) => particle.shape === "confetti")).toHaveLength(3);
    expect(new Set(early.map((particle) => particle.x)).size).toBe(4);
    expect(new Set(early.map((particle) => particle.rotation)).size).toBe(4);
    expect(early.some((particle, index) => particle.y !== late[index].y)).toBe(true);
  });

  it("makes sparkle feel like a compact radial reveal, not confetti drift", () => {
    const burst = sampleEffect(effect("sparkle"), 400);
    const confetti = sampleEffect(effect("confetti"), 400);
    const xSpan = Math.max(...burst.map((particle) => particle.x)) - Math.min(...burst.map((particle) => particle.x));

    expect(burst).toHaveLength(4);
    expect(xSpan).toBeGreaterThan(50);
    expect(new Set(burst.map((particle) => particle.color)).size).toBeGreaterThan(1);
    expect(burst.map((particle) => particle.shape)).not.toEqual(confetti.map((particle) => particle.shape));
  });

  it("gives surprise a readable pop punctuation beat", () => {
    const early = sampleEffect(effect("pop"), 320);
    const late = sampleEffect(effect("pop"), 820);

    expect(early.map((particle) => particle.shape)).toEqual([
      "pop-ring", "pop-ray", "pop-ray", "pop-ray",
    ]);
    expect(early[0].scale).toBeGreaterThan(0);
    expect(early.some((particle, index) => particle.scale !== late[index].scale)).toBe(true);
  });

  it("uses curved laugh marks for amusement instead of another sparkle burst", () => {
    const marks = sampleEffect(effect("laugh"), 360);
    const later = sampleEffect(effect("laugh"), 900);

    expect(marks).toHaveLength(4);
    expect(marks.every((particle) => particle.shape === "laugh-mark")).toBe(true);
    expect(new Set(marks.map((particle) => particle.rotation)).size).toBe(4);
    expect(marks.some((particle, index) => particle.scale !== later[index].scale)).toBe(true);
  });

  it("gives frustration one bubbly forehead mark with a finite pop and settle", () => {
    const early = sampleEffect(effect("anger"), 180);
    const settled = sampleEffect(effect("anger"), 720);

    expect(early).toHaveLength(1);
    expect(early[0].shape).toBe("anger-mark");
    expect(early[0].x).toBeGreaterThan(40);
    expect(early[0].y).toBeLessThan(-80);
    expect(early[0].scale).toBeGreaterThan(0);
    expect(settled[0].scale).not.toBeCloseTo(early[0].scale, 3);
    expect(settled[0].rotation).not.toBe(early[0].rotation);
    expect(sampleEffect(effect("anger"), EFFECT_DURATION + 1)).toEqual([]);
  });

  it("renders the legacy heart cue as one friendly golden greeting, never a heart", () => {
    const early = sampleEffect(effect("heart"), 120);
    const peak = sampleEffect(effect("heart"), 400);
    const settled = sampleEffect(effect("heart"), 900);

    expect(early).toHaveLength(1);
    expect(peak).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(peak[0].shape).toBe("friendly-mark");
    expect(peak[0].x).toBeGreaterThan(50);
    expect(peak[0].y).toBeLessThan(-55);
    expect(peak[0].scale).toBeGreaterThan(early[0].scale);
    expect(settled[0].x).toBeGreaterThan(early[0].x);
    expect(settled[0].rotation).not.toBe(peak[0].rotation);
    expect(peak[0].color).toBe("#efbb58");
    expect(peak[0].shape).not.toBe(sampleEffect(effect("sparkle"), 400)[0].shape);
  });

  it("is finite and respects reduced motion for every effect kind", () => {
    for (const kind of ["confetti", "sparkle", "heart", "pop", "laugh", "anger"] as const) {
      const reduced = sampleEffect(effect(kind), 400, true);
      const still = sampleEffect(effect(kind), 900, true);

      expect(reduced).toHaveLength(1);
      expect(reduced[0].x).toBe(still[0].x);
      expect(reduced[0].y).toBe(still[0].y);
      expect(reduced[0].rotation).toBe(0);
      expect(reduced[0].shape).toBe(kind === "pop" ? "pop-ring" : kind === "laugh" ? "laugh-mark" : kind === "anger" ? "anger-mark" : kind === "heart" ? "friendly-mark" : kind);
      expect(sampleEffect(effect(kind), EFFECT_DURATION + 1)).toEqual([]);
    }

    const reducedQuestion = sampleEffect(effect("question"), 400, true);
    expect(reducedQuestion.map((particle) => particle.shape)).toEqual(["question", "question-dot"]);
    expect(reducedQuestion.every((particle) => particle.rotation === 0)).toBe(true);
    expect(reducedQuestion.map((particle) => [particle.x, particle.y])).toEqual(
      sampleEffect(effect("question"), 900, true).map((particle) => [particle.x, particle.y]),
    );

    const reducedIdea = sampleEffect(effect("idea"), 400, true);
    expect(reducedIdea.map((particle) => particle.shape)).toEqual(["idea", "idea-ray", "idea-ray", "idea-ray"]);
    expect(reducedIdea.every((particle) => particle.rotation === 0)).toBe(true);

    for (const kind of ["question", "idea"] as const) {
      expect(sampleEffect(effect(kind), EFFECT_DURATION + 1)).toEqual([]);
    }
  });

  it("keeps every visible particle finite, local, and one-shot", () => {
    for (const kind of ["confetti", "sparkle", "heart", "question", "idea", "pop", "laugh", "anger"] as const) {
      for (const time of [0, 16, 120, 360, 900, 1_500, 1_999]) {
        const particles = sampleEffect(effect(kind), time);
        expect(particles.every((particle) => [
          particle.x,
          particle.y,
          particle.rotation,
          particle.scale,
          particle.opacity,
        ].every(Number.isFinite))).toBe(true);
        expect(particles.every((particle) => particle.opacity >= 0 && particle.opacity <= 1)).toBe(true);
      }
    }

    expect(sampleEffect(effect("confetti"), Number.NaN).every((particle) => Number.isFinite(particle.x))).toBe(true);
    expect(sampleEffect({ ...effect("sparkle"), strength: Number.NaN }, 400).every((particle) => Number.isFinite(particle.scale))).toBe(true);
  });

  it("retires an effect rapidly without changing its semantic shape", () => {
    const active = effect("sparkle");
    active.retiringAt = 600;
    const before = sampleEffect(active, 600);
    const after = sampleEffect(active, 780);

    expect(before).toHaveLength(4);
    expect(after).toHaveLength(4);
    expect(after.every((particle) => particle.opacity > 0)).toBe(false);
    expect(after.every((particle) => particle.shape === "sparkle")).toBe(true);
  });

  it("keeps question and idea semantically distinct from a sparkle burst", () => {
    const question = sampleEffect(effect("question"), 320);
    const idea = sampleEffect(effect("idea"), 320);
    const settledIdea = sampleEffect(effect("idea"), 900);
    const sparkle = sampleEffect(effect("sparkle"), 320);

    expect(question.map((particle) => particle.shape)).toEqual(["question", "question-dot"]);
    expect(question[0].rotation).toBeLessThan(0);
    expect(question[0].rotation).toBeLessThan(sampleEffect(effect("question"), 800)[0].rotation);
    expect(idea.map((particle) => particle.shape)).toEqual(["idea", "idea-ray", "idea-ray", "idea-ray"]);
    expect(new Set(idea.map((particle) => particle.rotation)).size).toBe(3);
    expect(idea[0].scale).toBeGreaterThan(settledIdea[0].scale);
    expect(idea[0].y).toBeLessThan(settledIdea[0].y);
    expect(idea[1].y).toBeLessThan(idea[0].y - 10);
    expect(Math.min(idea[2].x, idea[3].x)).toBeLessThan(idea[0].x - 20);
    expect(sparkle.every((particle) => particle.shape === "sparkle")).toBe(true);
  });

  it("keeps the question and insight paths inside their visible drawing clearance", () => {
    for (const kind of ["question", "idea", "heart", "pop", "anger"] as const) {
      for (const time of [120, 320, 800, 1_500]) {
        const particles = sampleEffect(effect(kind), time);
        for (const particle of particles) {
          const bounds = transformedBounds(particle as typeof particle & { shape: keyof typeof pathBounds });
          expect(bounds.minX).toBeGreaterThanOrEqual(-EFFECT_DRAWING_EXTENT);
          expect(bounds.maxX).toBeLessThanOrEqual(EFFECT_DRAWING_EXTENT);
          expect(bounds.minY).toBeGreaterThanOrEqual(-EFFECT_DRAWING_EXTENT);
          expect(bounds.maxY).toBeLessThanOrEqual(EFFECT_DRAWING_EXTENT);
        }
      }
    }
  });

  it("keeps attached effects safe through authored head and body transforms", () => {
    for (const kind of ["question", "idea", "heart", "pop", "anger"] as const) {
      for (const time of [320, 800]) {
        for (const bodyRotation of [-32, 32]) {
          for (const bodyX of [-21, 21]) {
            for (const bodyY of [-21, 21]) {
              for (const particle of sampleEffect(effect(kind), time)) {
                const bounds = characterBounds(
                  particle as typeof particle & { shape: keyof typeof pathBounds },
                  bodyRotation,
                  bodyX,
                  bodyY,
                  1.12,
                );
                expect(bounds.minX).toBeGreaterThanOrEqual(-EFFECT_DRAWING_EXTENT);
                expect(bounds.maxX).toBeLessThanOrEqual(EFFECT_DRAWING_EXTENT);
                expect(bounds.minY).toBeGreaterThanOrEqual(-EFFECT_DRAWING_EXTENT);
                expect(bounds.maxY).toBeLessThanOrEqual(EFFECT_DRAWING_EXTENT);
              }
            }
          }
        }
      }
    }
  });
});
