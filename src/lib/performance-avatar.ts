import type { FaceDefinition, FaceExpressionDefinition } from "./face-renderer";

type RawEye = readonly [width: number, height: number, x: number, y: number, angle: number];
type RawExpression = readonly [
  key: string,
  head: readonly [number, number, number],
  left: RawEye,
  right: RawEye,
  spacing: number,
];

const rawExpressions: readonly RawExpression[] = [
  ["neutral", [0, 0, 0], [20, 50, 0, -7, 0], [20, 50, 0, -7, 0], 35],
  ["upward-side-glance", [7.3, 27.8, -16.1], [22.5, 42.4, 0, -20.5, 0], [22.5, 42.4, 0, -20.5, 0], 54.3],
  ["downward-gaze", [-15.1, 0.1, -14.5], [22.4, 54.6, 0, 0, 0], [22.4, 54.6, 0, 0, 0], 57.7],
  ["skeptical-right", [-16.5, -3.8, -13.7], [23.1, 57.7, 0, 0, 0], [49.9, 12.4, 0, 0, 0], 56.3],
  ["small-attentive", [-4.2, 14.4, 11.2], [22.1, 39.6, 0, 0, 0], [22.1, 39.6, 0, 0, 0], 50.9],
  ["wide-downward-gaze", [-19.2, 15.2, 11.8], [52.1, 51.5, 0, 0, 0], [53.1, 52.2, 0, 0, 0], 69.5],
  ["surprised-left", [2.9, -16.1, -20.9], [51.7, 51.7, 0, 0, 0], [51.7, 51.7, 0, 0, 0], 70.9],
  ["sleepy-squint", [3.4, 13.2, 9], [51.8, 13, 0, 0, 0], [51.8, 13, 0, 0, 0], 63.9],
  ["angry-right", [8.1, 17.6, -11.1], [20.9, 40.4, 0, 0, -30.9], [20.9, 40.4, 0, 0, 28.8], 52.1],
  ["curious-left", [-12.3, -17.6, 5.9], [20.6, 47.8, 0, 0, 23.5], [20.6, 47.8, 0, 0, -24], 54.9],
  ["asymmetric-down-right", [-20.1, 12.6, -12.7], [42.5, 41.8, 0, 0, 0], [22.1, 22.2, 0, 0, 0], 61.7],
  ["attentive-left", [1.4, 6.2, 10.6], [23.8, 58.1, 0, 0, 0], [23.8, 58.1, 0, 0, 0], 56.8],
  ["joyful-wide", [-2.1, -15.9, -14.5], [34.2, 85.3, 0, 0, 0], [34.2, 83.2, 0, 0, 0], 59.4],
  ["eyes-closed", [-8.8, -8.7, -10.8], [56.1, 15.5, 0, 0, 0], [56.1, 15.2, 0, 0, 0], 69.3],
  ["joyful-down-right", [-15.3, 15, 12.8], [31.3, 76.7, 0, 0, 0], [31.3, 76.7, 0, 0, 0], 68.7],
  ["skeptical-left", [3.5, -7.1, 9.8], [24.3, 59.3, 0, 0, 0], [48.9, 13.4, 0, 0, 0], 62.2],
  ["far-right-glance", [0.3, 35.3, -10.9], [22.5, 39.8, 0, 0, 0], [22.5, 39.8, 0, 0, 0], 53.9],
  ["angry-left", [-14.8, -19.4, 5.6], [19.6, 48.6, 0, 0, -27.6], [19.6, 48.6, 0, 0, 26.1], 55.1],
  ["playful-right", [-4.4, 14.1, -16.1], [19, 43.4, 0, 0, 26.3], [19, 43.4, 0, 0, -20.2], 51.7],
  ["asymmetric-up-left", [6.6, 4.7, 12.8], [42.1, 41.7, 0, 0, 0], [22.2, 22.1, 0, 0, 0], 60.4],
  ["gentle-downward-gaze", [-6.1, -11, -14], [23, 58.7, 0, 0, 0], [23, 58.7, 0, 0, 0], 56.2],
  ["wide-down-left", [-17.1, 18.1, 13.9], [35.5, 79.1, 0, 0, 0], [35.5, 79.1, 0, 0, 0], 70.8],
  ["surprised-wide-left", [-5.4, -11.7, -13.5], [51.4, 50.1, 0, 0, 0], [50.5, 49.4, 0, 0, 0], 69],
  ["drowsy-closed", [10.3, 3.4, 7.6], [55.7, 14.6, 0, 0, 0], [55.7, 14.6, 0, 0, 0], 68.4],
  ["suspicious-right", [-17.8, 10, -10.9], [24, 55.9, 0, -9.8, 0], [53.6, 13.3, 0, -9.8, 0], 59.9],
  ["shy-downward", [7.1, 7.8, 3.9], [21.5, 32, 0, 40, 0], [23.2, 33.5, 0, 40, 0], 51.2],
  ["angry-brows", [10.5, 5.1, 4.7], [27.1, 63, 0, 0, -36.2], [27.1, 63, 0, 0, 27.7], 68.7],
  ["uneasy-left", [-12.3, -17.6, 5.9], [20.6, 47.8, 0, 0, 23.5], [20.6, 47.8, 0, 0, -24], 54.9],
];

function expression([, head, left, right, spacing]: RawExpression): FaceExpressionDefinition {
  return {
    head: { x: head[0], y: head[1], z: head[2] },
    eyes: {
      left: { width: left[0], height: left[1], x: left[2], y: left[3], angle: left[4] },
      right: { width: right[0], height: right[1], x: right[2], y: right[3], angle: right[4] },
      spacing,
    },
    perspective: 1,
    motion: { eyes: "none", body: "none" },
  };
}

const expressions = Object.fromEntries(rawExpressions.map((row) => [row[0], expression(row)]));

export const performanceExpressionKeys = rawExpressions.map(([key]) => key);

export const performanceAvatarDefinition: FaceDefinition = {
  name: "Mood Voice",
  radius: 120,
  colors: { body: "#f4f5f1", eyes: "#111316" },
  expressions,
  expressionOrder: performanceExpressionKeys,
};
