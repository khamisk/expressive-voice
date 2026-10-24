import { describe, expect, it } from "vitest";
import { missingTranscriptSuffix, OutputTranscriptStream, takeTranscriptChunk } from "./transcript-stream";

describe("transcript playback pacing", () => {
  it("releases one natural word chunk at a time", () => {
    expect(takeTranscriptChunk("Hello, how are you?")).toMatchObject({ chunk: "Hello, ", rest: "how are you?" });
  });

  it("does not race ahead just because generated text is backlogged", () => {
    const short = takeTranscriptChunk("Wonderful ");
    const backlogged = takeTranscriptChunk(`Wonderful ${"conversation ".repeat(12)}`);
    expect(backlogged?.delay).toBe(short?.delay);
  });

  it("only appends text missing from the final transcript", () => {
    expect(missingTranscriptSuffix("Hello there", "Hello there!")) .toBe("!");
    expect(missingTranscriptSuffix("Hello there", "Different text")).toBe("");
  });

  it("holds incomplete streamed words until a separator or final transcript", () => {
    expect(takeTranscriptChunk("conver")).toBeNull();
    expect(takeTranscriptChunk("conversation ")?.chunk).toBe("conversation ");
    expect(takeTranscriptChunk("conversation.", true)?.chunk).toBe("conversation.");
  });

  it("keeps word indices aligned when a sentence separator space is missing", () => {
    expect(takeTranscriptChunk("laugh.So a friend")).toMatchObject({ chunk: "laugh.", rest: "So a friend" });
    expect(takeTranscriptChunk("Really?yes exactly")).toMatchObject({ chunk: "Really?", rest: "yes exactly" });
    expect(takeTranscriptChunk("3.14 dollars")).toMatchObject({ chunk: "3.14 ", rest: "dollars" });
  });

  it("keeps rewritten dash and separated punctuation attached to its spoken word", () => {
    expect(takeTranscriptChunk("Wait — that worked")).toMatchObject({ chunk: "Wait — ", rest: "that worked" });
    expect(takeTranscriptChunk("worked–really well")).toMatchObject({ chunk: "worked–", rest: "really well" });
    expect(takeTranscriptChunk("Yes , that works")).toMatchObject({ chunk: "Yes , ", rest: "that works" });
  });
});

describe("multi-item output transcripts", () => {
  it("separates audio items and completes only the current item's missing suffix", () => {
    const stream = new OutputTranscriptStream();
    expect(stream.append("Checking.", "commentary")).toBe("Checking.");
    expect(stream.append("Checking.", "commentary", true)).toBe("");
    expect(stream.append("Carry your", "answer")).toBe(" Carry your");
    expect(stream.append("Carry your ID.", "answer", true)).toBe(" ID.");
    expect(stream.append("Checking.", "commentary", true)).toBe("");
  });

  it("preserves single-item streaming, word fragments, and existing whitespace", () => {
    const stream = new OutputTranscriptStream();
    expect(stream.append("Conver", "one")).toBe("Conver");
    expect(stream.append("sation. ", "one")).toBe("sation. ");
    expect(stream.append("Next.", "two", true)).toBe("Next.");
    stream.reset();
    expect(stream.append("Hello")).toBe("Hello");
    expect(stream.append("Hello!", undefined, true)).toBe("!");
  });
});
