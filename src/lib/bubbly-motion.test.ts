import { describe, expect, it } from "vitest";
import {
  CHARACTER_GESTURE_LIMITS,
  CHARACTER_GESTURE_DURATIONS,
  REST_GESTURE,
  sampleGesture,
  type CharacterGesture,
  type GesturePose,
} from "./character-gestures";

const punctuationGestures = ["nod", "lift", "lean-in"] as const;
type PunctuationGesture = (typeof punctuationGestures)[number];

function poseAt(gesture: CharacterGesture, elapsed: number, start: GesturePose = REST_GESTURE): GesturePose {
  return sampleGesture(gesture, elapsed, start);
}

function assertFiniteAndBounded(pose: GesturePose): void {
  for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true);
  expect(Math.abs(pose.headX)).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
  expect(Math.abs(pose.headY)).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
  expect(Math.abs(pose.headZ)).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
  expect(Math.abs(pose.x)).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
  expect(Math.abs(pose.y)).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
  expect(pose.scale).toBeGreaterThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMin);
  expect(pose.scale).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMax);
  expect(pose.squashX).toBeGreaterThanOrEqual(0.92);
  expect(pose.squashX).toBeLessThanOrEqual(1.12);
  expect(pose.squashY).toBeGreaterThanOrEqual(0.92);
  expect(pose.squashY).toBeLessThanOrEqual(1.12);
}

describe("bubbly character motion", () => {
  it("punctuates a beat with anticipation, stretch, rebound, and settle", () => {
    const arcs: Record<PunctuationGesture, readonly [number, number, number, number]> = {
      nod: [150, 300, 520, 1060] as const,
      lift: [160, 270, 700, 890] as const,
      "lean-in": [180, 560, 1080, 1230] as const,
    };

    for (const gesture of punctuationGestures) {
      const [anticipationTime, stretchTime, reboundTime, settleTime] = arcs[gesture];
      const anticipation = poseAt(gesture, anticipationTime);
      const stretch = poseAt(gesture, stretchTime);
      const rebound = poseAt(gesture, reboundTime);
      const settle = poseAt(gesture, settleTime);

      // The face compresses before the beat and lengthens into it. This is
      // the readable "bubbly" cue; it does not require random idle motion.
      expect(anticipation.squashX).toBeGreaterThan(1.03);
      expect(anticipation.squashY).toBeLessThan(0.98);
      if (gesture === "lean-in") {
        // A forward lean opens sideways as it lands, so its stretch is read
        // through the wider scale/body travel rather than a vertical pop.
        expect(stretch.squashX).toBeGreaterThan(1.03);
        expect(stretch.squashY).toBeLessThan(0.98);
        expect(stretch.scale).toBeGreaterThan(anticipation.scale);
        expect(Math.abs(stretch.x)).toBeGreaterThan(Math.abs(anticipation.x));
      } else {
        expect(stretch.squashX).toBeLessThan(0.99);
        expect(stretch.squashY).toBeGreaterThan(1.03);
      }

      // The rebound is visibly closer to neutral than the held stretch and
      // continues toward a rest-like pose instead of looping the beat.
      expect(Math.abs(rebound.squashX - 1) + Math.abs(rebound.squashY - 1))
        .toBeLessThan(Math.abs(stretch.squashX - 1) + Math.abs(stretch.squashY - 1));
      expect(Math.abs(settle.squashX - 1) + Math.abs(settle.squashY - 1))
        .toBeLessThan(Math.abs(rebound.squashX - 1) + Math.abs(rebound.squashY - 1));
    }
  });

  it("keeps the authored bubbly arcs finite and inside character bounds", () => {
    const allGestures: readonly CharacterGesture[] = [
      "still", "tilt-left", "tilt-right", "nod", "lift", "lean-in", "settle",
    ];

    for (const gesture of allGestures) {
      for (let elapsed = 0; elapsed <= CHARACTER_GESTURE_DURATIONS[gesture] + 160; elapsed += 16) {
        assertFiniteAndBounded(poseAt(gesture, elapsed));
      }
      // The authored final tail may retain a quiet tilt/offset. It is still
      // finite and stable; the performance spring owns the eventual return.
      expect(poseAt(gesture, CHARACTER_GESTURE_DURATIONS[gesture] + 160))
        .toEqual(poseAt(gesture, CHARACTER_GESTURE_DURATIONS[gesture] + 320));
    }
  });

  it("starts reversals from the visible pose without a teleport", () => {
    const visible: GesturePose = {
      headX: -8,
      headY: 2,
      headZ: -14,
      x: -9,
      y: 4,
      scale: 1.04,
      squashX: 1.05,
      squashY: 0.96,
    };

    expect(poseAt("lift", 0, visible)).toEqual(visible);
    expect(poseAt("nod", 0, visible)).toEqual(visible);
    expect(poseAt("lean-in", 0, visible)).toEqual(visible);
    expect(Math.abs(poseAt("lean-in", 16, visible).headZ - visible.headZ)).toBeLessThan(2);
  });

  it("keeps still as a genuine explicit no-motion gesture", () => {
    for (const elapsed of [0, 80, 400, 1400]) {
      expect(poseAt("still", elapsed)).toEqual(REST_GESTURE);
    }
  });
});
