import { describe, expect, it } from "vitest";
import { formatTranscript } from "./transcript";

describe("transcript formatting", () => {
  it("replaces em and en dashes with conversational punctuation", () => {
    expect(formatTranscript("Wait — that worked–really well.")).toBe("Wait, that worked, really well.");
  });

  it("leaves normal conversational text alone", () => {
    expect(formatTranscript("Yeah, that sounds good. Let's do it.")).toBe("Yeah, that sounds good. Let's do it.");
  });
});
