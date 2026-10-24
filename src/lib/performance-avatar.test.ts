import { validateAvatarDefinition } from "@bible-strong/avatar-core";
import { describe, expect, it } from "vitest";
import { performanceAvatarDefinition, performanceExpressionKeys } from "./performance-avatar";

describe("procedural reference geometry", () => {
  it("builds a valid portable avatar definition", () => {
    expect(validateAvatarDefinition(performanceAvatarDefinition)).toEqual({
      ok: true,
      value: performanceAvatarDefinition,
    });
  });

  it("preserves the source expression vocabulary without autonomous gaze timelines", () => {
    expect(performanceExpressionKeys).toHaveLength(28);
    expect(performanceAvatarDefinition.animations).toEqual({});
  });
});
