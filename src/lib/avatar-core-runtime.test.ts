import { describe, expect, it } from "vitest";
import {
  expressionFromDefinition as originalExpression,
  renderAvatarExpression as originalRender,
} from "@bible-strong/avatar-core";
import { expressionFromDefinition, renderAvatarExpression } from "./avatar-core-runtime";
import { performanceAvatarDefinition } from "./performance-avatar";

describe("SHERPA's browser-only avatar adapter", () => {
  it("preserves every original authored expression and rendered geometry", () => {
    for (const [key, definition] of Object.entries(performanceAvatarDefinition.expressions)) {
      const expression = expressionFromDefinition(key, definition);
      expect(expression).toEqual(originalExpression(key, definition));
      for (const blink of [0, 0.25, 1]) {
        expect(renderAvatarExpression(performanceAvatarDefinition, expression, {}, blink))
          .toEqual(originalRender(performanceAvatarDefinition, expression, {}, blink));
      }
      const colors = { body: "#f4f5f1", eyes: "#111316" };
      expect(renderAvatarExpression(performanceAvatarDefinition, expression, colors))
        .toEqual(originalRender(performanceAvatarDefinition, expression, colors));
    }
  });
});
