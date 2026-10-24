import { describe, expect, it } from "vitest";
import { expressionForPhase, expressionLabels, isSemanticExpression, semanticExpressions } from "./expressions";

describe("expression display state", () => {
  it("validates the public expressions without interpreting prose", () => {
    for (const expression of semanticExpressions) {
      expect(isSemanticExpression(expression)).toBe(true);
      expect(expressionLabels[expression]).toBeTruthy();
    }
    expect(isSemanticExpression("thinking")).toBe(false);
    expect(isSemanticExpression("I finally got the job!")).toBe(false);
  });

  it("keeps conversational state separate from the contextual emotional cue", () => {
    expect(expressionForPhase("listening", "neutral")).toBe("attentive");
    expect(expressionForPhase("thinking", "neutral")).toBe("thinking");
    expect(expressionForPhase("speaking", "joyful")).toBe("joyful");
    expect(expressionForPhase("listening", "concerned")).toBe("concerned");
    expect(expressionForPhase("idle", "joyful")).toBe("neutral");
    expect(expressionForPhase("error", "neutral")).toBe("concerned");
  });
});
