import { describe, expect, it } from "vitest";
import { renderAvatarExpression } from "./face-renderer";
import { smileEyePath } from "./eye-shapes";
import { performanceAvatarDefinition } from "./performance-avatar";
import { SpeechPerformance, speakingPortraits, type FacePerformanceInput } from "./speech-performance";

const pointsOf = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(point => [Number(point[1]), Number(point[2])]);
const commandsOf = (path: string) => path.match(/[MLZ]/g);
const scene = (mood: keyof typeof speakingPortraits) => renderAvatarExpression(performanceAvatarDefinition, speakingPortraits[mood]).geometry;

describe("simple expressive eye shapes", () => {
  it("keeps the same outline topology from open eye to a thick smiling arch", () => {
    // Use an authored short-eye fixture for the morph itself. The resting
    // amused portrait is intentionally open now; feeding it smile=1 directly
    // would test an invalid resting state rather than an earned smile beat.
    const path = "M-20 0L0 0L20 0L20 10L0 10L-20 10Z";
    const source = pointsOf(path);
    const full = pointsOf(smileEyePath(path, 1));
    const x = source.map(point => point[0]);
    const center = (Math.min(...x) + Math.max(...x)) / 2;
    const central = full.filter(point => Math.abs(point[0] - center) < 4);
    const edges = full.filter(point => Math.abs(point[0] - center) > (Math.max(...x) - Math.min(...x)) * 0.46);
    expect(Math.max(...central.map(point => point[1]))).toBeLessThan(Math.min(...edges.map(point => point[1])) - 3);
    expect(Math.max(...central.map(point => point[1])) - Math.min(...central.map(point => point[1]))).toBeGreaterThan(2);
    expect(Math.max(...full.map(point => point[1]))).toBeLessThan(Math.max(...source.map(point => point[1])));
    for (let step = 0; step <= 20; step++) {
      const next = smileEyePath(path, step / 20);
      expect(commandsOf(next)).toEqual(commandsOf(path));
      expect(pointsOf(next)).toHaveLength(source.length);
      expect(next).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(smileEyePath(path, 0)).toBe(path);
  });

  it("has a continuous morph with stable horizontal eye placement", () => {
    const path = scene("joyful").rightPath;
    let previous = pointsOf(path);
    for (let step = 1; step <= 60; step++) {
      const next = pointsOf(smileEyePath(path, step / 60));
      next.forEach((point, index) => {
        expect(point[0]).toBe(previous[index][0]);
        expect(Math.abs(point[1] - previous[index][1])).toBeLessThan(1.8);
      });
      previous = next;
    }
  });

  it("keeps the open eye of a wink tall and rounded", () => {
    const path = scene("playful").leftPath;
    const source = pointsOf(path);
    const shaped = pointsOf(smileEyePath(path, 0.25));
    const height = (points: number[][]) => Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
    expect(height(shaped)).toBeGreaterThan(height(source) * 0.9);
  });

  it("holds the selected reaction silhouette and honors a deliberately still pose", () => {
    for (const expression of ["playful", "surprised", "shy", "excited"] as const) {
      const controller = new SpeechPerformance();
      const study: FacePerformanceInput = { expression, phase: "listening", activity: { input: 0, output: 0 }, cue: {
        id: `study-${expression}`, turnId: `study-${expression}`, source: "user", kind: "reaction",
        expression, variant: `${expression}-present`, gesture: "still", accent: "none", confidence: 1, intensity: 1, effect: "none",
      } };
      let frame = controller.sample(study, 0);
      for (let time = 16; time <= 4000; time += 16) frame = controller.sample(study, time);
      expect(frame.gesture).toBe("still");
      expect(frame.expression.headZ).toBe(0);
      expect(frame.body.x).toBe(0);
      expect(frame.body.y).toBe(0);
      if (expression === "playful") expect(frame.expression.heightLeft / frame.expression.heightRight).toBeGreaterThan(2);
      if (expression === "surprised") expect(frame.expression.widthRight).toBeGreaterThan(58);
      if (expression === "excited") expect(frame.expression.heightLeft).toBeGreaterThan(90);
      if (expression === "shy") expect(frame.expression.positionYLeft).toBeGreaterThan(12);
    }
  });
});
