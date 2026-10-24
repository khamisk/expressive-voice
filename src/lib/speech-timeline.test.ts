import { describe, expect, it } from "vitest";
import { SpeechTimeline, type TimelineWord } from "./caption-clock";

const wordsFor = (timeline: SpeechTimeline): TimelineWord[] => [...timeline.words];

const collectAt = (timeline: SpeechTimeline, elapsed: number[], leadMs = 0): TimelineWord[] =>
  elapsed.flatMap((time) => timeline.advance(time, leadMs));

const ids = (words: readonly TimelineWord[]): number[] => words.map((word) => word.index);

describe("SpeechTimeline", () => {
  it("holds an incomplete streamed token and emits it once the token is complete", () => {
    const timeline = new SpeechTimeline();

    timeline.updateText("hello wor", false);
    expect(wordsFor(timeline).map((word) => word.text)).toEqual(["hello"]);

    const first = timeline.advance(500, 0);
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((word) => word.text)).not.toContain("wor");
    expect(timeline.advance(400, 0)).toEqual([]);

    timeline.updateText("hello world", true);
    expect(wordsFor(timeline).map((word) => word.text)).toEqual(["hello", "world"]);

    const second = timeline.advance(10_000, 0);
    expect(second.map((word) => word.text)).toContain("world");
    expect(timeline.releasedWords).toBe(2);
  });

  it("preserves source whitespace and newline positions in character offsets", () => {
    const source = "Hi  there\nfriend";
    const timeline = new SpeechTimeline();
    timeline.updateText(source, true);

    const words = wordsFor(timeline);
    expect(words.map((word) => word.text)).toEqual(["Hi", "there", "friend"]);
    // `charEnd` is the exclusive end of each raw emitted chunk, so it also
    // owns the separator after a word. This keeps a later caption slice from
    // dropping spaces or newlines when it advances by character offset.
    expect(words.map((word) => word.charEnd)).toEqual([4, 10, 16]);
    let previousEnd = 0;
    for (const word of words) {
      expect(source.slice(previousEnd, word.charEnd)).toBe(word.chunk);
      previousEnd = word.charEnd;
    }
    expect(words.map((word) => word.chunk.trim())).toEqual(words.map((word) => word.text));
  });

  it("never replays released words when duration is corrected", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("one two three four five six seven eight nine ten", true);

    const first = timeline.advance(500, 0);
    expect(first.length).toBeGreaterThan(0);
    const releasedBefore = timeline.releasedWords;

    timeline.setDuration(3_000, 500);
    expect(timeline.advance(500, 0)).toEqual([]);
    expect(timeline.releasedWords).toBe(releasedBefore);

    const later = timeline.advance(3_000, 0);
    expect(new Set(ids([...first, ...later])).size).toBe(first.length + later.length);
    expect(ids(later).every((index) => index >= releasedBefore)).toBe(true);
  });

  it("is invariant to frame cadence when elapsed time is the same", () => {
    const text = "one two three four five six seven eight nine ten";
    const fastFrames = new SpeechTimeline();
    const sparseFrames = new SpeechTimeline();
    fastFrames.updateText(text, true);
    sparseFrames.updateText(text, true);
    fastFrames.setDuration(3_200);
    sparseFrames.setDuration(3_200);

    const fast = collectAt(fastFrames, Array.from({ length: 65 }, (_, index) => index * 50));
    const sparse = collectAt(sparseFrames, [0, 400, 800, 1_200, 1_600, 2_000, 2_400, 2_800, 3_200]);

    expect(ids(fast)).toEqual(ids(sparse));
    expect(fast.map((word) => [word.startMs, word.endMs, word.charEnd])).toEqual(
      sparse.map((word) => [word.startMs, word.endMs, word.charEnd]),
    );
  });

  it("does not accumulate timeout drift across a long frame pause", () => {
    const text = "one two three four five six seven eight nine ten";
    const paused = new SpeechTimeline();
    const continuous = new SpeechTimeline();
    paused.updateText(text, true);
    continuous.updateText(text, true);
    paused.setDuration(3_200);
    continuous.setDuration(3_200);

    paused.advance(0, 0);
    paused.advance(350, 0);
    paused.advance(2_200, 0);

    collectAt(continuous, Array.from({ length: 111 }, (_, index) => index * 20));

    expect(paused.releasedWords).toBe(continuous.releasedWords);
    expect(ids(paused.advance(3_200, 0))).toEqual(ids(continuous.advance(3_200, 0)));
  });

  it("keeps already released timing frozen while fitting future words in a corrected budget", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("one two three four five six seven eight nine ten", true);
    timeline.setDuration(3_600);

    timeline.advance(700, 0);
    const released = timeline.releasedWords;
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThan(timeline.words.length);
    const frozenStarts = timeline.words.slice(0, released).map((word) => word.startMs);

    timeline.setDuration(2_400, 700);
    const afterCorrection = wordsFor(timeline);
    expect(afterCorrection.slice(0, released).map((word) => word.startMs)).toEqual(frozenStarts);
    expect(afterCorrection.at(-1)!.endMs).toBeLessThanOrEqual(2_400);

    timeline.advance(2_400, 0);
    expect(timeline.releasedWords).toBe(timeline.words.length);
  });

  it("ignores invalid duration corrections without creating non-finite timing", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("one two three four", true);
    const before = wordsFor(timeline).map((word) => [word.startMs, word.endMs]);

    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      timeline.setDuration(duration);
    }

    expect(wordsFor(timeline).map((word) => [word.startMs, word.endMs])).toEqual(before);
    expect(wordsFor(timeline).every((word) => Number.isFinite(word.startMs) && Number.isFinite(word.endMs))).toBe(true);
  });

  it("bounds unusual lead values and keeps peek side-effect free", () => {
    for (const leadMs of [-10_000, Number.NaN, Number.POSITIVE_INFINITY, 10_000]) {
      const timeline = new SpeechTimeline();
      timeline.updateText("one two three four", true);
      const before = timeline.releasedWords;
      const preview = timeline.peek(500, leadMs);

      expect(Number.isFinite(preview.wordCount)).toBe(true);
      expect(Number.isFinite(preview.charEnd)).toBe(true);
      expect(preview.wordCount).toBeGreaterThanOrEqual(0);
      expect(preview.wordCount).toBeLessThanOrEqual(timeline.words.length);
      expect(preview.charEnd).toBeGreaterThanOrEqual(0);
      expect(timeline.releasedWords).toBe(before);

      const due = timeline.advance(500, leadMs);
      expect(due.length).toBeLessThanOrEqual(timeline.words.length);
      expect(due.every((word) => Number.isFinite(word.startMs)
        && Number.isFinite(word.endMs)
        && word.startMs >= 0
        && word.endMs >= word.startMs)).toBe(true);
    }
  });

  it("resets text, timing, and release state completely", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("old words", true);
    timeline.advance(1_000, 0);
    expect(timeline.releasedWords).toBeGreaterThan(0);

    timeline.reset();
    expect(timeline.releasedWords).toBe(0);
    expect(wordsFor(timeline)).toEqual([]);
    expect(timeline.peek(1_000, 0)).toEqual({ wordCount: 0, charEnd: 0 });

    timeline.updateText("new words", true);
    expect(wordsFor(timeline).map((word) => word.text)).toEqual(["new", "words"]);
    expect(wordsFor(timeline).every((word) => word.index >= 0)).toBe(true);
  });

  it("keeps default timing finite and within a reasonable upper approximation", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("one two three four five six seven", true);

    const words = wordsFor(timeline);
    expect(words).toHaveLength(7);
    expect(words[0].startMs).toBeGreaterThanOrEqual(0);
    expect(words.at(-1)!.endMs).toBeLessThanOrEqual(7 * 650);
    expect(words.every((word, index) => Number.isFinite(word.startMs)
      && Number.isFinite(word.endMs)
      && word.startMs <= word.endMs
      && (index === 0 || words[index - 1].endMs <= word.startMs))).toBe(true);
  });

  it("holds the next phrase during a sustained observed pause and anchors it on resume", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("That hurt. I am sorry. How do you feel?", true);
    timeline.setDuration(4_000);

    const sentenceEnd = timeline.words[1].endMs;
    const beforePause = timeline.advance(sentenceEnd - 1, 0);
    expect(beforePause.map((word) => word.text)).toEqual(["That", "hurt."]);
    const releasedBeforePause = timeline.releasedWords;
    const scheduledNextStart = timeline.words[releasedBeforePause].startMs;

    timeline.observeAudio(sentenceEnd, true);
    timeline.observeAudio(sentenceEnd + 16, false);
    expect(timeline.peek(sentenceEnd + 500, 0).wordCount).toBe(releasedBeforePause);

    const resumedAt = sentenceEnd + 620;
    timeline.observeAudio(resumedAt, true);
    expect(timeline.words[releasedBeforePause].startMs).toBeGreaterThanOrEqual(resumedAt);
    expect(timeline.words[releasedBeforePause].startMs).toBeGreaterThan(scheduledNextStart);

    const afterResume = timeline.advance(resumedAt, 0);
    expect(afterResume.length).toBeGreaterThan(0);
    expect(afterResume.every((word) => word.index >= releasedBeforePause)).toBe(true);
  });

  it("does not turn a short inter-word gap into a phrase anchor", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("That hurt. I am sorry. How do you feel?", true);
    timeline.setDuration(4_000);

    const sentenceEnd = timeline.words[1].endMs;
    timeline.advance(sentenceEnd - 1, 0);
    const nextStart = timeline.words[timeline.releasedWords].startMs;

    timeline.observeAudio(sentenceEnd, true);
    timeline.observeAudio(sentenceEnd + 16, false);
    timeline.observeAudio(sentenceEnd + 100, true);

    expect(timeline.words[timeline.releasedWords].startMs).toBe(nextStart);
  });

  it("uses a bounded fallback when a candidate pause never resumes", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("That hurt. I am sorry. How do you feel?", true);
    timeline.setDuration(4_000);

    const sentenceEnd = timeline.words[1].endMs;
    timeline.advance(sentenceEnd - 1, 0);
    timeline.observeAudio(sentenceEnd, true);
    timeline.observeAudio(sentenceEnd + 16, false);

    const held = timeline.peek(sentenceEnd + 1_000, 0);
    expect(held.wordCount).toBe(timeline.releasedWords);

    const fallback = timeline.peek(sentenceEnd + 16 + 1_800, 0);
    expect(fallback.wordCount).toBeGreaterThanOrEqual(timeline.releasedWords);
    expect(fallback.wordCount).toBeLessThanOrEqual(timeline.words.length);
  });

  it("keeps a pause anchor and the final word inside the known budget as text grows", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("That hurt. I am sorry. How do you feel?", true);
    timeline.setDuration(4_000);

    const sentenceEnd = timeline.words[1].endMs;
    timeline.advance(sentenceEnd - 1, 0);
    const released = timeline.releasedWords;
    const frozenStarts = timeline.words.slice(0, released).map((word) => word.startMs);
    timeline.observeAudio(sentenceEnd, true);
    timeline.observeAudio(sentenceEnd + 16, false);
    timeline.observeAudio(sentenceEnd + 620, true);

    timeline.updateText("That hurt. I am sorry. How do you feel? More importantly, you are not alone.", true);

    expect(timeline.words.slice(0, released).map((word) => word.startMs)).toEqual(frozenStarts);
    expect(timeline.words[released].startMs).toBeGreaterThanOrEqual(sentenceEnd + 620);
    expect(timeline.words.at(-1)!.endMs).toBeLessThanOrEqual(4_000);
  });

  it("replays the measured long pause without delaying the boundary word or leaking the next phrase", () => {
    // The recorded empathy-correction WAV has its first voiced phrase ending
    // around 1.16s and the next phrase resuming around 2.08s. The local
    // playback clock starts at the first audible sample, so this replay uses
    // approximately 0.78s and 1.70s relative offsets.
    const timeline = new SpeechTimeline();
    timeline.updateText("I was wrong about that. Thanks for catching it. That sounds frustrating, but we can fix it together.", true);
    timeline.setDuration(6_500);

    for (let elapsed = 0; elapsed <= 780; elapsed += 16) {
      timeline.observeAudio(elapsed, true);
      timeline.advance(elapsed, 80);
    }

    timeline.observeAudio(780, false);
    for (let elapsed = 796; elapsed <= 960; elapsed += 16) {
      timeline.observeAudio(elapsed, false);
      timeline.advance(elapsed, 80);
    }
    timeline.observeAudio(960, false);
    timeline.advance(960, 80);

    // The boundary word may be released at the quiet edge, but “Thanks” must
    // remain held until the measured second phrase actually resumes.
    expect(timeline.words[4].startMs).toBeLessThanOrEqual(960);
    expect(timeline.peek(1_650, 80).wordCount).toBeLessThanOrEqual(5);

    timeline.observeAudio(1_700, true);
    expect(timeline.words[5].startMs).toBeGreaterThanOrEqual(1_700);
    const resumed = timeline.advance(1_700, 0);
    expect(resumed.map((word) => word.text)).toContain("Thanks");
  });

  it("does not invent a pause anchor for the single-question side clip", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText("What’s going on on your side?", true);
    timeline.setDuration(2_650);
    const before = timeline.words.map((word) => [word.startMs, word.endMs]);

    for (let elapsed = 0; elapsed <= 1_800; elapsed += 16) {
      timeline.observeAudio(elapsed, true);
      timeline.advance(elapsed, 0);
    }
    timeline.observeAudio(1_800, false);
    timeline.observeAudio(2_040, true);

    expect(timeline.words.map((word) => [word.startMs, word.endMs])).toEqual(before);
    expect(timeline.releasedWords).toBe(timeline.words.length);
  });
});
