/**
 * Offline audit: how closely the character's face follows the actual voice.
 *
 * Plays recorded Cedar replies through the same per-frame meter, speech
 * timeline and SpeechPerformance controller the live app uses, then compares
 * the rendered eye motion to syllables found in the audio itself.
 *
 *   npx tsx scripts/audit-voice-sync.ts [--json out.json]
 *
 * Reference syllables come from a non-causal analysis of the whole file, so
 * they are a stand-in for listening, not phoneme ground truth. No provider
 * calls, browser or audio device are used.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SpeechTimeline } from "../src/lib/caption-clock";
import { SpeechPerformance } from "../src/lib/speech-performance";
import { speechPunctuation } from "../src/lib/spoken-caption";
import { VoiceBeatDetector } from "../src/lib/voice-beats";
import type { AvatarExpression } from "../src/types";

const FRAME_MS = 1000 / 60;
/** Web Audio contexts usually run at 48 kHz; the old meter read 256 of those samples. */
const LEGACY_WINDOW_SECONDS = 256 / 48000;

type Clip = { id: string; file: string; text: string; expression: AvatarExpression };

function readWav(path: string): { samples: Float32Array; rate: number } {
  const data = readFileSync(path);
  let offset = 12;
  let rate = 24000;
  let channels = 1;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = data.readUInt16LE(offset + 10);
      rate = data.readUInt32LE(offset + 12);
    } else if (id === "data") {
      const count = Math.floor(size / 2 / channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No PCM data in ${path}`);
}

/** Non-causal syllable nuclei: peaks of the speech-band loudness envelope. */
function referenceSyllables(samples: Float32Array, rate: number): number[] {
  const hop = Math.round(rate * 0.01);
  const win = Math.round(rate * 0.03);
  let highPassed = 0;
  let previous = 0;
  const filtered = new Float32Array(samples.length);
  const alpha = Math.exp((-2 * Math.PI * 250) / rate);
  for (let i = 0; i < samples.length; i++) {
    highPassed = alpha * (highPassed + samples[i] - previous);
    previous = samples[i];
    filtered[i] = highPassed;
  }
  const env: number[] = [];
  for (let start = 0; start + win <= filtered.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + win; i++) sum += filtered[i] * filtered[i];
    env.push(10 * Math.log10(sum / win + 1e-10));
  }
  const smooth = env.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(env.length - 1, i + 2); j++) { s += env[j]; n++; }
    return s / n;
  });
  const loudest = Math.max(...smooth);
  const peaks: number[] = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] < loudest - 30 || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    // Prominence: the envelope must dip at least 3 dB on both sides within 200 ms.
    let leftMin = smooth[i], rightMin = smooth[i];
    for (let j = i - 1; j >= Math.max(0, i - 20); j--) leftMin = Math.min(leftMin, smooth[j]);
    for (let j = i + 1; j <= Math.min(smooth.length - 1, i + 20); j++) rightMin = Math.min(rightMin, smooth[j]);
    if (smooth[i] - leftMin < 3 || smooth[i] - rightMin < 3) continue;
    const at = i * 10 + 15;
    if (peaks.length && at - peaks[peaks.length - 1] < 90) {
      if (smooth[i] > smooth[Math.round((peaks[peaks.length - 1] - 15) / 10)]) peaks[peaks.length - 1] = at;
      continue;
    }
    peaks.push(at);
  }
  return peaks;
}

function estimateSyllables(text: string): number {
  return text.split(/\s+/).filter(Boolean).reduce((sum, word) => {
    const plain = word.toLowerCase().replace(/[^a-z']/g, "");
    const groups = plain.match(/[aeiouy]+/g)?.length ?? 1;
    return sum + Math.max(1, groups - (/[^aeiou]e$/.test(plain) ? 1 : 0));
  }, 0);
}

type Mode = "before" | "after";

/** Simulates the live pipeline frame by frame and returns the visible eye signal. */
function simulate(clip: Clip, samples: Float32Array, rate: number, mode: Mode) {
  const durationMs = (samples.length / rate) * 1000;
  const performance = new SpeechPerformance(clip.expression);
  const timeline = new SpeechTimeline();
  timeline.updateText(clip.text, true);
  timeline.setDuration(durationMs, 0);
  const detector = new VoiceBeatDetector();
  let smoothed = 0;
  let wordTick = 0;
  let phraseTick = 0;
  let previousEnded = false;
  let punctuation: ReturnType<typeof speechPunctuation> = "none";
  const visible: Array<{ t: number; eyes: number }> = [];
  const frameSamples = Math.round((rate * FRAME_MS) / 1000);

  for (let t = 0; t <= durationMs + 400; t += FRAME_MS) {
    const end = Math.min(samples.length, Math.round((t / 1000) * rate));
    const legacyWindow = Math.max(1, Math.round(LEGACY_WINDOW_SECONDS * rate));
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, end - legacyWindow); i < end; i++) { sum += samples[i] * samples[i]; n++; }
    const rms = n ? Math.sqrt(sum / n) : 0;
    const target = Math.min(1, rms * 5.5);
    smoothed += (target - smoothed) * (target > smoothed ? 0.34 : 0.18);

    for (const word of timeline.advance(t)) {
      const mark = speechPunctuation(word.text);
      if (previousEnded) phraseTick += 1;
      previousEnded = mark !== "none";
      wordTick = word.index + 1;
      punctuation = mark;
    }

    const activity: Parameters<SpeechPerformance["sample"]>[0]["activity"] = {
      input: 0, output: smoothed, wordTick, phraseTick, punctuation,
    };
    if (mode === "after") {
      const frame = samples.subarray(Math.max(0, end - frameSamples), end);
      const beat = detector.push(frame, rate, t);
      activity.output = beat.level;
      activity.syllableTick = beat.syllableTick;
      activity.syllableStrength = beat.strength;
    }
    const sample = performance.sample({ phase: "speaking", expression: clip.expression, activity }, t);
    const e = sample.expression;
    visible.push({ t, eyes: (e.heightLeft + e.heightRight) * sample.openness + (sample.body.squashY - 1) * 120 });
  }
  return visible;
}

/** Peaks in upward eye motion: the frames where an articulation pulse is visibly rising fastest. */
function visiblePulses(signal: Array<{ t: number; eyes: number }>): number[] {
  const velocity = signal.map((s, i) => (i ? (s.eyes - signal[i - 1].eyes) / FRAME_MS * 1000 : 0));
  const peaks: number[] = [];
  for (let i = 1; i < velocity.length - 1; i++) {
    if (velocity[i] > 25 && velocity[i] >= velocity[i - 1] && velocity[i] > velocity[i + 1]) {
      if (peaks.length && signal[i].t - peaks[peaks.length - 1] < 70) continue;
      peaks.push(signal[i].t);
    }
  }
  return peaks;
}

function score(reference: number[], pulses: number[]) {
  // A pulse "belongs" to a syllable when its fastest rise lands between 120 ms
  // before the syllable peak (the consonant/onset) and 60 ms after it.
  const lags: number[] = [];
  let hit = 0;
  for (const syllable of reference) {
    const match = pulses.filter((p) => p - syllable >= -120 && p - syllable <= 60)
      .sort((a, b) => Math.abs(a - syllable) - Math.abs(b - syllable))[0];
    if (match !== undefined) { hit++; lags.push(match - syllable); }
  }
  // Lag of the nearest visible pulse after each syllable onset region, within 400 ms.
  const delays = reference.map((syllable) => pulses.find((p) => p >= syllable - 120 && p <= syllable + 400))
    .map((p, i) => (p === undefined ? null : p - reference[i])).filter((d): d is number => d !== null);
  const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : NaN);
  return {
    syllables: reference.length,
    pulses: pulses.length,
    coverage: reference.length ? hit / reference.length : 0,
    medianDelayMs: median(delays),
    stray: Math.max(0, pulses.length - hit),
  };
}

const clips: Clip[] = [];
const performanceManifest = JSON.parse(readFileSync("public/performance/manifest.json", "utf8"));
const moods: Record<string, AvatarExpression> = {
  curious: "curious", celebration: "joyful", playful: "playful", gentle: "concerned", "surprise-empathy-interest": "surprised",
};
for (const recording of performanceManifest.recordings) {
  clips.push({ id: recording.id, file: `public/performance/${recording.filename}`, text: recording.transcript ?? recording.text, expression: moods[recording.id] ?? "neutral" });
}
const audit = JSON.parse(readFileSync("public/performance/timing-audit/final-2026-08-27/manifest.json", "utf8"));
for (const clip of audit.clips ?? []) {
  const file = clip.filename ?? clip.file;
  const text = clip.transcript ?? clip.text;
  if (file && text) clips.push({ id: `audit-${clip.id ?? file}`, file: `public/performance/timing-audit/final-2026-08-27/${file}`, text, expression: "neutral" });
}

const results: Record<string, unknown>[] = [];
const totals: Record<Mode, { hit: number; syl: number; stray: number; delays: number[] }> = {
  before: { hit: 0, syl: 0, stray: 0, delays: [] },
  after: { hit: 0, syl: 0, stray: 0, delays: [] },
};
const modes: Mode[] = process.argv.includes("--before-only") ? ["before"] : ["before", "after"];
for (const clip of clips) {
  const { samples, rate } = readWav(clip.file);
  const reference = referenceSyllables(samples, rate);
  const row: Record<string, unknown> = { id: clip.id, seconds: +(samples.length / rate).toFixed(2), syllablesInAudio: reference.length, syllablesInText: estimateSyllables(clip.text) };
  for (const mode of modes) {
    const s = score(reference, visiblePulses(simulate(clip, samples, rate, mode)));
    row[mode] = s;
    totals[mode].hit += s.coverage * s.syllables;
    totals[mode].syl += s.syllables;
    totals[mode].stray += s.stray;
    if (Number.isFinite(s.medianDelayMs)) totals[mode].delays.push(s.medianDelayMs);
  }
  results.push(row);
  const fmt = (m: Mode) => {
    const s = row[m] as ReturnType<typeof score> | undefined;
    return s ? `${m}: ${(s.coverage * 100).toFixed(0)}% covered, median delay ${s.medianDelayMs.toFixed(0)} ms, ${s.stray} stray` : "";
  };
  console.log(`${clip.id.padEnd(30)} ${String(reference.length).padStart(3)} syllables (text ~${row.syllablesInText})  ${modes.map(fmt).join("  |  ")}`);
}
for (const mode of modes) {
  const t = totals[mode];
  const median = [...t.delays].sort((a, b) => a - b)[Math.floor(t.delays.length / 2)];
  console.log(`TOTAL ${mode}: ${(t.hit / t.syl * 100).toFixed(1)}% of ${t.syl} syllables get a visible pulse on time; median delay ${median.toFixed(0)} ms; ${t.stray} pulses not on a syllable`);
}
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ results, totals }, null, 2));
