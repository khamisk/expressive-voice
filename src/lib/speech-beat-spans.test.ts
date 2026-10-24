import { describe, expect, it } from "vitest";
import { speechBeatSpans } from "./speech-beat-spans";

describe("early speech beat spans", () => {
  it("keeps a short interjection with the meaning that follows it", () => {
    expect(speechBeatSpans("Oof, that really hurts. I'm sorry.", true).map(s => s.text))
      .toEqual(["Oof, that really hurts.", "I'm sorry."]);
  });
  it("gives a mixed feeling a separate anchored beat", () => {
    expect(speechBeatSpans("You can be excited and still feel the tug of leaving your friends.", true).map(s => s.text))
      .toEqual(["You can be excited", "and still feel the tug of leaving your friends."]);
  });
  it("never classifies an unfinished generated token", () => {
    expect(speechBeatSpans("That sounds really genuinely won").map(s => s.text))
      .toEqual(["That sounds really genuinely"]);
    expect(speechBeatSpans("That sounds rea")).toEqual([]);
  });
  it("keeps the same origin while the first thought grows", () => {
    const before = speechBeatSpans("That sounds really genuinely wonderful ")[0];
    const after = speechBeatSpans("That sounds really genuinely wonderful to me.")[0];
    expect(before.start).toBe(after.start);
    expect(after.end).toBeGreaterThan(before.end);
  });
  it("does not split a linked final question or abbreviations", () => {
    expect(speechBeatSpans("What's going on on your side?", true).map(s => s.text))
      .toEqual(["What's going on on your side?"]);
    expect(speechBeatSpans("Dr. Smith said hello.", true)).toHaveLength(1);
  });
});
