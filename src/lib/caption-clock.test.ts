import { describe, expect, it } from "vitest";
import { takeTranscriptChunk } from "./transcript-stream";
import {
  CAPTION_DELAY_MAX_MS,
  CAPTION_DELAY_MIN_MS,
  captionDelay,
} from "./caption-clock";

function delayWeight(text: string): number {
  let rest = text;
  let total = 0;
  while (rest) {
    const chunk = takeTranscriptChunk(rest, true);
    if (!chunk || chunk.rest === rest) break;
    total += chunk.delay;
    rest = chunk.rest;
  }
  return total;
}

describe("caption clock", () => {
  it("always returns a finite delay for invalid numeric inputs", () => {
    expect(Number.isFinite(captionDelay({ baseDelay: Number.NaN, remainingText: "later", remainingAudioMs: 900 }))).toBe(true);
    expect(Number.isFinite(captionDelay({ baseDelay: Number.POSITIVE_INFINITY, remainingText: "later", remainingAudioMs: 900 }))).toBe(true);
    expect(Number.isFinite(captionDelay({ baseDelay: -1, remainingText: "later", remainingAudioMs: Number.NaN }))).toBe(true);
    expect(Number.isFinite(captionDelay({ baseDelay: 220, remainingText: "later", remainingAudioMs: Number.POSITIVE_INFINITY }))).toBe(true);
  });

  it("preserves the normal delay when backlog has no real audio budget", () => {
    const baseDelay = 278;
    const remainingText = "one two three four five six seven eight nine ten";
    expect(captionDelay({ baseDelay, remainingText })).toBe(baseDelay);
    expect(captionDelay({ baseDelay, remainingText, remainingAudioMs: Number.NaN })).toBe(baseDelay);
    expect(captionDelay({ baseDelay, remainingText, remainingAudioMs: 0 })).toBe(baseDelay);
  });

  it("allocates a long voice budget by chunk weight", () => {
    const baseDelay = 238;
    const remainingText = "the next sentence has several natural words";
    const remainingAudioMs = 1800;
    const weighted = delayWeight(remainingText);
    const expected = Math.min(
      CAPTION_DELAY_MAX_MS,
      Math.max(CAPTION_DELAY_MIN_MS, (baseDelay / (baseDelay + weighted)) * remainingAudioMs),
    );
    expect(captionDelay({ baseDelay, remainingText, remainingAudioMs })).toBe(expected);
    expect(captionDelay({ baseDelay: 238, remainingText: "the", remainingAudioMs })).toBeGreaterThan(
      captionDelay({ baseDelay: 238, remainingText, remainingAudioMs }),
    );
  });

  it("keeps an audio-backed delay inside the end bounds", () => {
    expect(captionDelay({ baseDelay: 220, remainingText: "later", remainingAudioMs: 1 })).toBe(CAPTION_DELAY_MIN_MS);
    expect(captionDelay({ baseDelay: 220, remainingText: "later", remainingAudioMs: 100_000 })).toBe(CAPTION_DELAY_MAX_MS);
  });
});
