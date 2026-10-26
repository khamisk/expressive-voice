import { describe, expect, it } from "vitest";
import { HeardDelay, VoiceBeatDetector, outputDelayMs } from "./voice-beats";

const RATE = 24000;

/** Voiced bursts (a 180 Hz buzz with harmonics) separated by near-silence. */
function syllableTrain(onsetsMs: number[], lengthMs: number, loudness: (index: number) => number = () => 0.3): Float32Array {
  const samples = new Float32Array(Math.round((lengthMs / 1000) * RATE));
  onsetsMs.forEach((onset, index) => {
    const start = Math.round((onset / 1000) * RATE);
    const length = Math.round(0.14 * RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / RATE;
      const envelope = Math.sin((Math.PI * i) / length) ** 0.5;
      const buzz = Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 720 * t) + 0.4 * Math.sin(2 * Math.PI * 1440 * t);
      samples[start + i] = buzz * envelope * loudness(index) * 0.5;
    }
  });
  return samples;
}

function run(samples: Float32Array, frameMs = 1000 / 60) {
  const detector = new VoiceBeatDetector();
  const beats: Array<{ at: number; strength: number }> = [];
  let last = 0;
  const step = Math.round((frameMs / 1000) * RATE);
  for (let end = step; end <= samples.length; end += step) {
    const state = detector.push(samples.subarray(end - step, end), RATE, (end / RATE) * 1000);
    if (state.syllableTick !== last) {
      last = state.syllableTick;
      beats.push({ at: state.syllableAtMs ?? NaN, strength: state.strength });
    }
  }
  return beats;
}

describe("voice beat detection", () => {
  it("finds one beat per syllable, near each syllable's onset", () => {
    const onsets = [100, 330, 520, 760, 1100, 1300, 1560];
    const beats = run(syllableTrain(onsets, 1900));
    expect(beats).toHaveLength(onsets.length);
    beats.forEach((beat, index) => {
      expect(beat.at - onsets[index]).toBeGreaterThanOrEqual(0);
      expect(beat.at - onsets[index]).toBeLessThan(45);
    });
  });

  it("stays quiet in silence and low noise", () => {
    const noise = new Float32Array(RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.0004;
    expect(run(noise)).toHaveLength(0);
  });

  it("does not depend on how the audio is chunked into frames", () => {
    const train = syllableTrain([120, 400, 700, 950], 1200);
    const at60 = run(train, 1000 / 60).map((beat) => beat.at);
    const at144 = run(train, 1000 / 144).map((beat) => beat.at);
    expect(at144).toHaveLength(at60.length);
    at144.forEach((at, index) => expect(Math.abs(at - at60[index])).toBeLessThan(6));
  });

  it("marks louder syllables as stronger", () => {
    const loud = new Set([3, 6]);
    const beats = run(syllableTrain([100, 330, 560, 790, 1020, 1250, 1480, 1710], 2000, (i) => (loud.has(i) ? 0.75 : 0.22)));
    expect(beats).toHaveLength(8);
    const quiet = beats.filter((_, i) => !loud.has(i) && i > 1).map((beat) => beat.strength);
    for (const i of loud) expect(beats[i].strength).toBeGreaterThan(Math.max(...quiet));
  });

  it("rises immediately with the voice and falls back in silence", () => {
    const detector = new VoiceBeatDetector();
    const loud = new Float32Array(400).fill(0.12);
    expect(detector.push(loud, RATE, 16).level).toBeGreaterThan(0.6);
    let state = detector.push(new Float32Array(400), RATE, 32);
    for (let t = 48; t < 400; t += 16) state = detector.push(new Float32Array(400), RATE, t);
    expect(state.level).toBeLessThan(0.01);
  });
});

describe("heard delay", () => {
  it("releases values only once the listener can hear them", () => {
    const delay = new HeardDelay(0);
    expect(delay.push(1, 0, 100)).toBe(0);
    expect(delay.push(2, 50, 100)).toBe(0);
    expect(delay.push(3, 100, 100)).toBe(1);
    expect(delay.push(4, 151, 100)).toBe(2);
  });

  it("passes values straight through with no output latency", () => {
    const delay = new HeardDelay(0);
    expect(delay.push(5, 10, 0)).toBe(5);
  });

  it("bounds a bad latency value", () => {
    const delay = new HeardDelay(0);
    expect(delay.push(1, 0, Number.NaN)).toBe(1);
    expect(delay.push(2, 0, 10_000)).toBe(1);
    expect(delay.push(3, 401, 10_000)).toBe(2);
  });

  it("measures device latency from the output timestamp when available", () => {
    const context = { currentTime: 10, getOutputTimestamp: () => ({ contextTime: 9.96 }), outputLatency: 0.5, baseLatency: 0.5 } as unknown as AudioContext;
    expect(outputDelayMs(context)).toBeCloseTo(40, 5);
    const fallback = { currentTime: 10, outputLatency: 0.18, baseLatency: 0.01 } as unknown as AudioContext;
    expect(outputDelayMs(fallback)).toBeCloseTo(190, 5);
    expect(outputDelayMs(null)).toBe(0);
  });
});
