import { validateFaceDefinition } from "./face-renderer";
import { describe, expect, it } from "vitest";
import { performanceAvatarDefinition, performanceExpressionKeys } from "./performance-avatar";

describe("procedural reference geometry", () => {
  it("builds a valid face definition", () => {
    expect(validateFaceDefinition(performanceAvatarDefinition)).toEqual({
      ok: true,
      value: performanceAvatarDefinition,
    });
  });

  it("preserves the source expression vocabulary", () => {
    expect(performanceExpressionKeys).toHaveLength(28);
    expect(performanceAvatarDefinition.expressionOrder).toEqual(performanceExpressionKeys);
  });
});
