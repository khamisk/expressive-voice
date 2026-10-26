import { describe, expect, it } from "vitest";
import { SpeechTimeline } from "./caption-clock";
import { SpeechPerformance, type VoiceActivity } from "./speech-performance";

describe("sentence gate", () => {
  const text = "That is a lot. Tell me more about it.";
  const startOf = (timeline: SpeechTimeline, word: string) => timeline.words.findIndex((entry) => entry.text.startsWith(word));

  it("holds the next sentence until the voice actually pauses and resumes", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText(text, true);
    const tell = startOf(timeline, "Tell");
    // "Tell" is estimated at ~1 s, but the first sentence is spoken slowly:
    // the voice keeps going until 1.5 s, pauses, and resumes at 1.8 s. The
    // bounded fallback (~2.6 s) is far away, so only the real pause can
    // release the next sentence here.
    let released = 0;
    for (let t = 0; t < 1800; t += 16) {
      timeline.observeAudio(t, t < 1500);
      released += timeline.advance(t, 0).length;
    }
    expect(timeline.releasedWords).toBe(tell);
    for (let t = 1800; t <= 1900; t += 16) {
      timeline.observeAudio(t, true);
      released += timeline.advance(t, 0).length;
    }
    expect(timeline.releasedWords).toBeGreaterThan(tell);
    expect(released).toBe(timeline.releasedWords);
  });

  it("never waits longer than its bounded fallback when no pause is heard", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText(text, true);
    const tell = startOf(timeline, "Tell");
    const sentenceEnd = timeline.words[tell - 1].endMs;
    for (let t = 0; t <= sentenceEnd + 1_700; t += 16) {
      timeline.observeAudio(t, true);
      timeline.advance(t, 0);
    }
    expect(timeline.releasedWords).toBeGreaterThan(tell);
  });

  it("does not gate a timeline that is not being fed audio", () => {
    const timeline = new SpeechTimeline();
    timeline.updateText(text, true);
    const tell = startOf(timeline, "Tell");
    expect(timeline.advance(timeline.words[tell].startMs, 0).length).toBe(tell + 1);
  });
});

describe("syllable pulses", () => {
  const eyeHeight = (frame: ReturnType<SpeechPerformance["sample"]>) => frame.expression.heightLeft + frame.expression.heightRight;

  function drive(phase: "speaking" | "listening", ticks: number[]) {
    const performance = new SpeechPerformance("neutral");
    const activity: VoiceActivity = { input: 0, output: 0.4, syllableTick: 0, syllableStrength: 0.8 };
    const frames: Array<{ t: number; height: number }> = [];
    for (let t = 0; t <= 1200; t += 16) {
      activity.syllableTick = ticks.filter((at) => at <= t).length;
      const frame = performance.sample({ phase, expression: "neutral", activity }, t);
      frames.push({ t, height: eyeHeight(frame) });
    }
    return frames;
  }

  const at = (frames: Array<{ t: number; height: number }>, t: number) => frames.find((frame) => frame.t >= t)!.height;

  it("lifts the eyes on a stressed syllable and settles afterwards", () => {
    const quiet = drive("speaking", []);
    const pulsed = drive("speaking", [600]);
    expect(at(pulsed, 690) - at(quiet, 690)).toBeGreaterThan(5);
    expect(Math.abs(at(pulsed, 1100) - at(quiet, 1100))).toBeLessThan(0.5);
  });

  it("accents beats, not every syllable, so fast syllables cannot shake the eyes", () => {
    // Seven syllables in 420 ms (fast speech). Only the first two are far
    // enough apart to become visible beats.
    const quiet = drive("speaking", []);
    const fast = drive("speaking", [300, 360, 420, 480, 540, 600, 660]);
    let reversals = 0;
    let direction = 0;
    for (let i = 1; i < fast.length; i++) {
      const move = (fast[i].height - quiet[i].height) - (fast[i - 1].height - quiet[i - 1].height);
      if (Math.abs(move) < 0.05) continue;
      if (direction !== 0 && Math.sign(move) !== direction) reversals++;
      direction = Math.sign(move);
    }
    expect(reversals).toBeLessThanOrEqual(3);
  });

  it("does not pulse for syllables while listening", () => {
    const quiet = drive("listening", []);
    const ticked = drive("listening", [300, 600, 900]);
    ticked.forEach((frame, index) => expect(frame.height).toBeCloseTo(quiet[index].height, 6));
  });
});
