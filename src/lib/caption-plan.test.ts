import { describe, expect, it } from "vitest";
import { parseCaptionBreaks } from "./reaction-cues";
import { CaptionPlanner, captionWords, captionWindow } from "./spoken-caption";

describe("streamed caption plans", () => {
  it("parses the captions array before the slower cues object is complete", () => {
    const source = "First complete thought. The next short phrase.";
    const captions = ["First complete thought.", "The next short phrase."];
    const raw = `{"captions":${JSON.stringify(captions)},"cues":[`;

    expect(parseCaptionBreaks(raw, source)).toEqual([0, 3]);
  });

  it("accepts only captions whose words exactly reproduce the source in order", () => {
    const source = "Keep every word in this line.";
    expect(parseCaptionBreaks(JSON.stringify({ captions: ["Keep every word", "in this line."] }), source))
      .toEqual([0, 3]);

    const invalidCaptions = [
      ["Keep every extra word", "in this line."],
      ["Keep every word", "this in line."],
      ["Keep every word in this"],
      ["Keep every word", "in this line.", "again"],
    ];
    for (const captions of invalidCaptions) {
      expect(parseCaptionBreaks(JSON.stringify({ captions }), source)).toBeNull();
    }
  });

  it("merges a model split that would strand your side", () => {
    const source = "What's going on on your side?";
    const raw = JSON.stringify({ captions: ["What's going on on your", "side?"] });

    expect(parseCaptionBreaks(raw, source)).toEqual([0]);
    expect(captionWindow(source, {
      plannedText: source,
      breakBeforeWords: parseCaptionBreaks(raw, source) ?? [],
    })).toMatchObject({ text: source, startWord: 0 });
  });

  it("handles escaped quotes, newlines, and closing brackets inside caption strings", () => {
    const source = 'She said, "wait [please]".\nThen she laughed.';
    const captions = ['She said, "wait [please]".\n', "Then she laughed."];
    const raw = `{"captions":${JSON.stringify(captions)},"cues":`;

    expect(parseCaptionBreaks(raw, source)).toEqual([0, 4]);
  });

  it("does not add or replay a break behind words that are already spoken", () => {
    const planner = new CaptionPlanner();
    const source = "Today feels calm now";

    expect(planner.update(source, { breakBeforeWords: [2], spokenWords: 0 }).breaks).toEqual([0, 2]);
    expect(planner.update(source, { breakBeforeWords: [2, 3], spokenWords: 3 }).breaks).toEqual([0, 2, 3]);

    // A late plan proposes a new break at word 1, but that word is already
    // spoken. The committed break at 2 remains exactly once.
    const stale = planner.update(source, { breakBeforeWords: [1, 2], spokenWords: 3 });
    expect(stale.breaks.filter((at) => at < 3)).toEqual([0, 2]);
    expect(stale.breaks).not.toContain(1);
    expect(stale.breaks.filter((at) => at === 2)).toHaveLength(1);
  });

  it("uses planned lookahead only for boundaries and never reveals unspoken words", () => {
    const fullText = "That was unexpected. I want to hear what happens next.";
    const audiblePrefix = "That was unexpected. I";
    const frame = captionWindow(audiblePrefix, {
      plannedText: fullText,
      breakBeforeWords: [3],
    });

    expect(frame).toMatchObject({
      text: "I",
      startWord: 3,
      totalWords: 4,
    });
    expect(frame.text).not.toContain("want");
    expect(frame.text).not.toContain("next");
  });

  it("uses planned lookahead to avoid a one-word tail in a long caption", () => {
    const source = "The story starts with a quiet moment. Then everything changes in a surprising way.";
    const raw = JSON.stringify({ captions: [
      "The story starts with a quiet moment.",
      "Then everything changes in a surprising",
      "way.",
    ] });
    const breaks = parseCaptionBreaks(raw, source);

    expect(breaks).not.toBeNull();
    const frame = captionWindow(source, { plannedText: source, breakBeforeWords: breaks ?? [] });
    expect(frame.text).toBe("Then everything changes in a surprising way.");
    expect(frame.words.length).toBeGreaterThan(1);
  });

  it("falls back to a safe whole thought for invalid, unsafe, or unsorted breaks", () => {
    const source = "What is going on on your side?";
    const invalidPlans = [
      [6],             // unsafe break before "side?"
      [6, 3],          // unsorted unsafe breaks
      [999, -1, 6],    // out-of-range values mixed with an unsafe break
    ];

    for (const breakBeforeWords of invalidPlans) {
      expect(captionWindow(source, { plannedText: source, breakBeforeWords })).toMatchObject({
        text: source,
        startWord: 0,
        totalWords: 7,
      });
    }
  });

  it("does not start a window between the verb and its object", () => {
    const source = "The thing that I wanted to tell you is that the answer is finally ready.";
    const frame = captionWindow(source);

    // The old fixed-size fallback produced exactly: "you is that the answer ...".
    expect(frame.text).not.toMatch(/^you\s+is\b/iu);
    expect(frame.words.length).toBeGreaterThan(1);
    expect(frame.startWord + frame.words.length).toBe(captionWords(source).length);
  });

  it("keeps an all-linked long run bounded instead of making an oversized bubble", () => {
    const linkedWords = [
      "the", "a", "your", "to", "of", "for", "with", "about", "and", "or", "but",
      "because", "in", "on", "at", "very", "really", "not", "you", "we", "it", "is", "that",
    ];
    const source = `${Array.from({ length: 42 }, (_, index) => linkedWords[index % linkedWords.length]).join(" ")}.`;
    const frame = captionWindow(source);

    expect(source.length).toBeGreaterThan(160);
    expect(frame.text.length).toBeLessThan(160);
    expect(frame.words.length).toBeGreaterThan(1);
    expect(frame.startWord + frame.words.length).toBe(frame.totalWords);
  });
});
