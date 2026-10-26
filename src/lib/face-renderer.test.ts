import { describe, expect, it } from "vitest";
import {
  EYE_OUTLINE_POINTS,
  expressionFromDefinition,
  renderAvatarExpression,
  validateFaceDefinition,
  type Expression,
} from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import { speakingPortraits } from "./speech-performance";

const pointsOf = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const bounds = (path: string) => {
  const points = pointsOf(path);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};
const render = (expression: Expression, openness = 1) =>
  renderAvatarExpression(performanceAvatarDefinition, expression, undefined, openness).geometry;
const neutral = speakingPortraits.neutral;

describe("face renderer", () => {
  it("draws every eye with the same point count so frames morph point-for-point", () => {
    for (const portrait of Object.values(speakingPortraits)) {
      for (const openness of [1, 0.5, 0]) {
        const scene = render({ ...portrait, headX: 12, headY: -18 }, openness);
        expect(pointsOf(scene.leftPath)).toHaveLength(EYE_OUTLINE_POINTS);
        expect(pointsOf(scene.rightPath)).toHaveLength(EYE_OUTLINE_POINTS);
        expect(scene.leftPath + scene.rightPath + scene.headPath).not.toMatch(/NaN|Infinity|undefined|e[-+]/);
      }
    }
  });

  it("places a symmetric face symmetrically", () => {
    const scene = render(neutral);
    const left = bounds(scene.leftPath);
    const right = bounds(scene.rightPath);
    expect(left.x).toBeCloseTo(-right.x, 1);
    expect(left.y).toBeCloseTo(right.y, 1);
    expect(left.width).toBeCloseTo(right.width, 1);
    expect(scene.leftVisible && scene.rightVisible).toBe(true);
  });

  it("closes to a thin lid without losing the eye's width or position", () => {
    const open = bounds(render(neutral, 1).leftPath);
    const shut = bounds(render(neutral, 0).leftPath);
    expect(shut.height).toBeLessThan(open.height * 0.15);
    expect(shut.height).toBeGreaterThan(4);
    expect(shut.width).toBeCloseTo(open.width, 0);
    expect(shut.y).toBeCloseTo(open.y, 0);
  });

  it("turns the head: looking up lifts the eyes, looking right slides and foreshortens them", () => {
    const front = render(neutral);
    const up = render({ ...neutral, headX: 20 });
    const right = render({ ...neutral, headY: 30 });
    expect(bounds(up.leftPath).y).toBeLessThan(bounds(front.leftPath).y - 30);
    expect(bounds(right.leftPath).x).toBeGreaterThan(bounds(front.leftPath).x + 50);
    expect(bounds(right.rightPath).width).toBeLessThan(bounds(front.rightPath).width * 0.8);
  });

  it("keeps both eyes level when the head looks up and to the side together", () => {
    const scene = render({ ...neutral, headX: 20, headY: 30 });
    expect(Math.abs(bounds(scene.leftPath).y - bounds(scene.rightPath).y)).toBeLessThan(4);
  });

  it("hides an eye that turns behind the head", () => {
    const scene = render({ ...neutral, headY: 85 });
    expect(scene.rightVisible).toBe(false);
  });

  it("draws the head outline slightly larger than the sphere under perspective", () => {
    const radius = Number(render(neutral).headPath.match(/^M([\d.]+)/)?.[1]);
    expect(radius).toBeGreaterThan(performanceAvatarDefinition.radius);
    expect(radius).toBeLessThan(performanceAvatarDefinition.radius * 1.05);
  });

  it("prefers explicit colors, then expression colors, then the definition", () => {
    const tinted = { ...neutral, bodyColor: "#111111" };
    expect(renderAvatarExpression(performanceAvatarDefinition, tinted).colors.body).toBe("#111111");
    expect(renderAvatarExpression(performanceAvatarDefinition, tinted, { body: "#222222" }).colors.body).toBe("#222222");
    expect(renderAvatarExpression(performanceAvatarDefinition, neutral).colors.eyes).toBe(performanceAvatarDefinition.colors.eyes);
  });

  it("round-trips a definition into an expression", () => {
    const expression = expressionFromDefinition("neutral", performanceAvatarDefinition.expressions.neutral);
    expect(expression.widthLeft).toBe(performanceAvatarDefinition.expressions.neutral.eyes.left.width);
    expect(expression.spacing).toBe(performanceAvatarDefinition.expressions.neutral.eyes.spacing);
  });

  it("rejects malformed definitions", () => {
    const broken = { ...performanceAvatarDefinition, radius: Number.NaN, expressionOrder: ["missing"] };
    const result = validateFaceDefinition(broken);
    expect(result.ok).toBe(false);
  });
});
