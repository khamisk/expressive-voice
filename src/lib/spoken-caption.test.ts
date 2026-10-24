import { describe, expect, it } from "vitest";
import { captionWindow, speechPunctuation } from "./spoken-caption";

const wordsOf = (text: string) => text.trim().split(/\s+/u).filter(Boolean);

describe("semantic spoken caption windows", () => {
  it("keeps an ordinary thought together instead of slicing it at five words", () => {
    expect(captionWindow("I'm so sorry to hear that happened.")).toMatchObject({
      text: "I'm so sorry to hear that happened.",
      startWord: 0,
      totalWords: 7,
    });

    expect(captionWindow("I'm so sorry to hear that happened. That really sucks.")).toMatchObject({
      text: "That really sucks.",
      startWord: 7,
      totalWords: 10,
    });
  });

  it("does not strand the final word of a dependent phrase", () => {
    const cases = [
      ["What's going on on your side?", "your side?", "side?"],
      ["That is a really useful answer.", "useful answer.", "answer."],
      ["I'm glad you're here with your friend today.", "your friend", "friend today."],
    ] as const;

    for (const [line, intactPhrase, orphan] of cases) {
      const frame = captionWindow(line);
      expect(frame.text, line).toContain(intactPhrase);
      expect(frame.text, line).not.toBe(orphan);
      expect(frame.words.length, line).toBeGreaterThan(1);
    }
  });

  it("treats explicit line breaks as hard thought boundaries", () => {
    expect(captionWindow("I'm so sorry to hear that happened\nThat really sucks")).toMatchObject({
      text: "That really sucks",
      startWord: 7,
      totalWords: 10,
    });

    expect(captionWindow("First thought\nA second thought")).toMatchObject({
      text: "A second thought",
      startWord: 2,
      totalWords: 5,
    });
  });

  it("keeps a short interjection attached when its punctuation is a soft boundary", () => {
    expect(captionWindow("Oh, that hurts.")).toMatchObject({
      text: "Oh, that hurts.",
      startWord: 0,
    });
    expect(captionWindow("Wow, that was close!")).toMatchObject({
      text: "Wow, that was close!",
      startWord: 0,
    });

    // A hard sentence boundary still starts the next thought, while retaining
    // the interjection as a complete outgoing window for the UI transition.
    expect(captionWindow("Oh! That's rough.")).toMatchObject({
      text: "That's rough.",
      startWord: 1,
    });
  });

  it("keeps the current window identity stable while its words stream in", () => {
    const prefixes = [
      "That",
      "That really",
      "That really sucks.",
      "That really sucks. How",
      "That really sucks. How do",
      "That really sucks. How do you",
      "That really sucks. How do you feel?",
    ];
    const frames = prefixes.map((text) => captionWindow(text));

    expect(frames.slice(0, 3).map((frame) => frame.startWord)).toEqual([0, 0, 0]);
    expect(frames.slice(3).map((frame) => frame.startWord)).toEqual([3, 3, 3, 3]);

    for (const [index, frame] of frames.entries()) {
      expect(frame.totalWords).toBe(wordsOf(prefixes[index]).length);
      expect(frame.words.at(-1)).toBe(wordsOf(prefixes[index]).at(-1));
      expect(frame.startWord + frame.words.length).toBe(frame.totalWords);
    }
  });

  it("keeps a long response readable without ending on a dangling function word", () => {
    const line = "The first part sets the scene, and the second part explains why the timing matters for everyone involved.";
    const frame = captionWindow(line, { maxCharacters: 54 });

    expect(frame.text.length).toBeLessThanOrEqual(54);
    expect(frame.words.length).toBeGreaterThan(1);
    expect(frame.text).toMatch(/[.!?]$/u);
    expect(frame.text).not.toMatch(/\b(?:a|an|the|and|but|or|to|of|for|on|in|your)$/iu);
  });

  it("preserves all streamed words as one contiguous visible window", () => {
    const source = "One small thought. Then a second one is ready.";
    const sourceWords = wordsOf(source);
    let previousStart = 0;
    let previousEnd = 0;

    for (let count = 1; count <= sourceWords.length; count += 1) {
      const frame = captionWindow(sourceWords.slice(0, count).join(" "));
      expect(frame.totalWords).toBe(count);
      expect(frame.startWord).toBeGreaterThanOrEqual(previousStart);
      expect(frame.startWord).toBeLessThanOrEqual(previousEnd);
      expect(frame.startWord + frame.words.length).toBe(count);
      expect(frame.words.at(-1)).toBe(sourceWords[count - 1]);
      previousStart = frame.startWord;
      previousEnd = frame.startWord + frame.words.length;
    }
  });

  it("fixes missing sentence spacing without changing decimal or abbreviation text", () => {
    expect(captionWindow("laugh.So a friend").text).toBe("So a friend");
    expect(captionWindow("It cost 3.14 dollars.").text).toBe("It cost 3.14 dollars.");
    expect(captionWindow("Dr. Smith was here.").text).toBe("Dr. Smith was here.");
  });

  it("limits a fragment by readable length and preserves a long word intact", () => {
    expect(captionWindow("Surprisingly extraordinary circumstances happened", { maxCharacters: 32 }).text)
      .toBe("circumstances happened");
    const longWord = "pneumonoultramicroscopicsilicovolcanoconiosis";
    expect(captionWindow(longWord).text).toBe(longWord);
  });

  it("handles empty content, Unicode, quotes and each punctuation boundary", () => {
    expect(captionWindow(" \n ").words).toEqual([]);
    expect(speechPunctuation("really?\" ")).toBe("question");
    expect(speechPunctuation("wow!’")).toBe("exclamation");
    expect(speechPunctuation("right,")).toBe("comma");
    expect(speechPunctuation("okay.")).toBe("sentence");
    expect(speechPunctuation("3.14")).toBe("none");
    expect(captionWindow("C’est une très bonne idée.").words).toHaveLength(5);
  });
});
