import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTION_LEAD_MS, SpeechTimeline, type TimelineWord } from "../src/lib/caption-clock.ts";

/**
 * Offline, read-only timing replay.
 *
 * This deliberately makes no provider calls and writes no artifacts. It uses
 * the saved WAVs and timing-audit manifest as evidence, then runs the same
 * absolute SpeechTimeline twice: once without coarse audio-pause observations
 * and once with the WAV's approximated output-meter observations.
 *
 * The transcript is loaded in full at playback-relative t=0. That is an
 * explicitly idealized replay so the comparison measures clock behavior, not
 * server transcript-arrival latency. The exact recorded transcript-delta
 * schedule is printed separately; its elapsedMs values are local provider
 * event-arrival time, not a browser/device playback clock.
 */

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const auditDirectory = path.join(projectDirectory, "public", "performance", "timing-audit", "final-2026-08-27");
const manifestPath = path.join(auditDirectory, "manifest.json");

const OUTPUT_AUDIBLE_THRESHOLD = 0.018;
const TARGET_GAIN = 5.5;
const RISE_SMOOTHING = 0.34;
const FALL_SMOOTHING = 0.18;
const METER_FRAME_MS = 16;

type AuditEvent = {
  type: string;
  elapsedMs?: number;
  pcmSamplesCumulative?: number;
  audioOffsetMs?: number;
  delta?: string;
  transcriptCumulative?: string;
};

type WhisperWord = {
  word: string;
  startMs: number;
  endMs: number;
};

type AuditClip = {
  id: string;
  filename: string;
  transcript: string;
  durationSeconds: number;
  sampleRate: number;
  pcmSamples: number;
  firstAudioDeltaMs: number;
  firstTranscriptDeltaMs: number;
  lastAudioDeltaMs: number;
  lastTranscriptDeltaMs: number;
  whisper?: { words: WhisperWord[] };
  timeline: AuditEvent[];
  audioDeltas: AuditEvent[];
  transcriptDeltas: AuditEvent[];
};

type AuditManifest = {
  sampleRate: number;
  clips: AuditClip[];
};

type WavData = {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
};

type MeterFrame = {
  absoluteMs: number;
  rms: number;
  smoothed: number;
  audible: boolean;
};

type Release = {
  word: TimelineWord;
  releaseRelativeMs: number;
  releaseAbsoluteMs: number;
  signedErrorMs: number;
  absoluteErrorMs: number;
};

type ReplayResult = {
  mode: "without-observeAudio" | "with-observeAudio";
  firstAudibleMs: number;
  releases: Release[];
  missingWords: string[];
  maeMs: number;
  maxErrorMs: number;
};

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as T;
}

function parseWav(filename: string): WavData {
  const data = fs.readFileSync(filename);
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Expected a RIFF/WAVE file: ${filename}`);
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === "fmt ") {
      audioFormat = data.readUInt16LE(chunkStart);
      channels = data.readUInt16LE(chunkStart + 2);
      sampleRate = data.readUInt32LE(chunkStart + 4);
      bitsPerSample = data.readUInt16LE(chunkStart + 14);
    } else if (id === "data") {
      dataOffset = chunkStart;
      dataLength = length;
      break;
    }
    offset = chunkStart + length + (length & 1);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate <= 0 || dataOffset < 0) {
    throw new Error(`Only PCM16 WAV input is supported by this diagnostic: ${filename}`);
  }

  const frameBytes = channels * 2;
  const frameCount = Math.floor(Math.min(dataLength, data.length - dataOffset) / frameBytes);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    const frameOffset = dataOffset + frame * frameBytes;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = data.readInt16LE(frameOffset + channel * 2) / 32_768;
      sum += sample * sample;
    }
    samples[frame] = Math.sqrt(sum / channels);
  }
  return { samples, sampleRate, channels };
}

function buildMeterFrames(wav: WavData): MeterFrame[] {
  const samplesPerFrame = Math.max(1, Math.round(wav.sampleRate * METER_FRAME_MS / 1_000));
  const frames: MeterFrame[] = [];
  let smoothed = 0;

  for (let frame = 0, start = 0; start < wav.samples.length; frame += 1, start += samplesPerFrame) {
    const end = Math.min(wav.samples.length, start + samplesPerFrame);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += wav.samples[sample] ** 2;
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    const target = Math.min(1, rms * TARGET_GAIN);
    smoothed += (target - smoothed) * (target > smoothed ? RISE_SMOOTHING : FALL_SMOOTHING);
    frames.push({
      absoluteMs: frame * METER_FRAME_MS,
      rms,
      smoothed,
      audible: smoothed > OUTPUT_AUDIBLE_THRESHOLD,
    });
  }
  return frames;
}

function formatMs(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function formatSignedMs(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}ms`;
}

function compact(value: string | undefined): string {
  return JSON.stringify(value ?? "");
}

function audioOffsetMs(event: AuditEvent, sampleRate: number): number | null {
  if (Number.isFinite(event.audioOffsetMs)) return event.audioOffsetMs!;
  if (Number.isFinite(event.pcmSamplesCumulative) && sampleRate > 0) {
    return (event.pcmSamplesCumulative! / sampleRate) * 1_000;
  }
  return null;
}

function replayClip(
  clip: AuditClip,
  wav: WavData,
  observeAudio: boolean,
): ReplayResult {
  const meter = buildMeterFrames(wav);
  const firstAudible = meter.find((frame) => frame.audible)?.absoluteMs ?? 0;
  const timeline = new SpeechTimeline();
  timeline.updateText(clip.transcript, true);
  timeline.setDuration(clip.durationSeconds * 1_000);

  const whisperWords = clip.whisper?.words ?? [];
  const spokenToken = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[’‘′ʼ]/gu, "'").replace(/[^\p{L}\p{N}']/gu, "");
  if (whisperWords.length !== timeline.words.length || timeline.words.some((word, index) =>
    spokenToken(word.text) !== spokenToken(whisperWords[index]?.word ?? ""))) {
    throw new Error(`The approximate word reference does not match the transcript for ${clip.id}; no alignment score is valid.`);
  }
  const releases: Release[] = [];
  const released = new Set<number>();
  for (const frame of meter) {
    if (frame.absoluteMs < firstAudible) continue;
    const relativeMs = frame.absoluteMs - firstAudible;
    if (observeAudio) timeline.observeAudio(relativeMs, frame.audible);
    for (const word of timeline.advance(relativeMs, CAPTION_LEAD_MS)) {
      if (released.has(word.index)) continue;
      released.add(word.index);
      const reference = whisperWords[word.index];
      const referenceStart = reference?.startMs ?? word.startMs;
      const releaseAbsoluteMs = firstAudible + relativeMs;
      const signedErrorMs = releaseAbsoluteMs - referenceStart;
      releases.push({
        word,
        releaseRelativeMs: relativeMs,
        releaseAbsoluteMs,
        signedErrorMs,
        absoluteErrorMs: Math.abs(signedErrorMs),
      });
    }
  }

  // Give the absolute clock one bounded final drain at the end of the saved
  // audio. This is not extra audio and is only to report any final caption
  // that landed on the terminal frame.
  const finalRelativeMs = Math.max(0, clip.durationSeconds * 1_000 - firstAudible);
  for (const word of timeline.advance(finalRelativeMs, 0)) {
    if (released.has(word.index)) continue;
    released.add(word.index);
    const reference = whisperWords[word.index];
    const releaseAbsoluteMs = firstAudible + finalRelativeMs;
    const referenceStart = reference?.startMs ?? word.startMs;
    const signedErrorMs = releaseAbsoluteMs - referenceStart;
    releases.push({
      word,
      releaseRelativeMs: finalRelativeMs,
      releaseAbsoluteMs,
      signedErrorMs,
      absoluteErrorMs: Math.abs(signedErrorMs),
    });
  }

  const missingWords = timeline.words.filter((word) => !released.has(word.index)).map((word) => word.text);
  const errors = releases.map((release) => release.absoluteErrorMs);
  return {
    mode: observeAudio ? "with-observeAudio" : "without-observeAudio",
    firstAudibleMs: firstAudible,
    releases: releases.sort((left, right) => left.word.index - right.word.index),
    missingWords,
    maeMs: errors.length ? errors.reduce((sum, error) => sum + error, 0) / errors.length : Number.NaN,
    maxErrorMs: errors.length ? Math.max(...errors) : Number.NaN,
  };
}

function printEventSchedule(clip: AuditClip, sampleRate: number): void {
  console.log("  Transcript deltas (provider-local arrival clock; not playback time):");
  for (const [index, event] of clip.transcriptDeltas.entries()) {
    const arrival = Number.isFinite(event.elapsedMs) ? formatMs(event.elapsedMs!) : "n/a";
    const audio = audioOffsetMs(event, sampleRate);
    console.log(`    ${String(index + 1).padStart(2, "0")} arrival=${arrival} audioSamplesOffset=${audio === null ? "n/a" : formatMs(audio)} delta=${compact(event.delta)} cumulative=${compact(event.transcriptCumulative)}`);
  }

  console.log("  Audio deltas (provider-local arrival and cumulative PCM offset):");
  for (const [index, event] of clip.audioDeltas.entries()) {
    const arrival = Number.isFinite(event.elapsedMs) ? formatMs(event.elapsedMs!) : "n/a";
    const audio = audioOffsetMs(event, sampleRate);
    console.log(`    ${String(index + 1).padStart(2, "0")} arrival=${arrival} audioSamplesOffset=${audio === null ? "n/a" : formatMs(audio)}`);
  }

  const done = clip.timeline.filter((event) => event.type === "response.done");
  if (!done.length) {
    console.log("  response.done: not recorded in this manifest (the stream audit ends at the final audio delta).");
  } else {
    console.log(`  response.done events: ${done.map((event) => Number.isFinite(event.elapsedMs) ? formatMs(event.elapsedMs!) : "arrival n/a").join(", ")}`);
  }
}

function printReplay(label: string, result: ReplayResult, whisperWords: WhisperWord[]): void {
  console.log(`  ${label}: first-audible anchor=${formatMs(result.firstAudibleMs)}; MAE=${formatMs(result.maeMs)}; max=${formatMs(result.maxErrorMs)}${result.missingWords.length ? `; missing=${result.missingWords.join(" ")}` : ""}`);
  console.log("    word                 release(abs) release(rel) refStart signedError absError");
  for (const release of result.releases) {
    const reference = whisperWords[release.word.index];
    console.log(`    ${release.word.text.padEnd(20, " ")} ${formatMs(release.releaseAbsoluteMs).padStart(11, " ")} ${formatMs(release.releaseRelativeMs).padStart(11, " ")} ${formatMs(reference?.startMs ?? release.word.startMs).padStart(8, " ")} ${formatSignedMs(release.signedErrorMs).padStart(11, " ")} ${formatMs(release.absoluteErrorMs).padStart(8, " ")}`);
  }
}

function aggregate(results: ReplayResult[]): { count: number; maeMs: number; maxMs: number } {
  const errors = results.flatMap((result) => result.releases.map((release) => release.absoluteErrorMs));
  return {
    count: errors.length,
    maeMs: errors.length ? errors.reduce((sum, error) => sum + error, 0) / errors.length : Number.NaN,
    maxMs: errors.length ? Math.max(...errors) : Number.NaN,
  };
}

const manifest = readJson<AuditManifest>(manifestPath);
const selectedId = process.argv.find((argument) => argument.startsWith("--clip="))?.slice("--clip=".length);
const clips = manifest.clips.filter((clip) => !selectedId || clip.id === selectedId);
if (!clips.length) throw new Error(selectedId ? `No audit clip found for --clip=${selectedId}` : "Manifest contains no clips.");

console.log("Offline speech-timing comparison");
console.log(`Source: ${path.relative(projectDirectory, manifestPath)}`);
console.log("Replay input: final text and total audio duration loaded at playback-relative t=0 (idealized; provider delta arrival is not used as a playback timestamp).");
console.log(`Meter approximation: ${METER_FRAME_MS}ms PCM RMS frames, gain=${TARGET_GAIN}, smoothing rise=${RISE_SMOOTHING}, fall=${FALL_SMOOTHING}, threshold=${OUTPUT_AUDIBLE_THRESHOLD}.`);
console.log(`Timeline lead: ${CAPTION_LEAD_MS}ms, matching the caption release path. Whisper starts are approximate reference labels only.`);

const noObserve: ReplayResult[] = [];
const observed: ReplayResult[] = [];
for (const clip of clips) {
  const wav = parseWav(path.join(auditDirectory, clip.filename));
  const durationMs = wav.samples.length / wav.sampleRate * 1_000;
  console.log(`\n${clip.id} — ${clip.filename} (${formatMs(durationMs)}, ${wav.sampleRate}Hz, ${wav.channels} channel)`);
  console.log(`  Provider summary: firstTranscript=${formatMs(clip.firstTranscriptDeltaMs)}, firstAudioDelta=${formatMs(clip.firstAudioDeltaMs)}, lastTranscript=${formatMs(clip.lastTranscriptDeltaMs)}, lastAudioDelta=${formatMs(clip.lastAudioDeltaMs)}.`);
  printEventSchedule(clip, manifest.sampleRate);

  const without = replayClip(clip, wav, false);
  const withAudio = replayClip(clip, wav, true);
  noObserve.push(without);
  observed.push(withAudio);
  const whisperWords = clip.whisper?.words ?? [];
  printReplay("without observeAudio", without, whisperWords);
  printReplay("with observeAudio", withAudio, whisperWords);
}

const noObserveAggregate = aggregate(noObserve);
const observedAggregate = aggregate(observed);
console.log("\nAggregate approximate-start error");
console.log(`  without observeAudio: ${noObserveAggregate.count} words, MAE=${formatMs(noObserveAggregate.maeMs)}, max=${formatMs(noObserveAggregate.maxMs)}`);
console.log(`  with observeAudio:    ${observedAggregate.count} words, MAE=${formatMs(observedAggregate.maeMs)}, max=${formatMs(observedAggregate.maxMs)}`);
console.log("\nLimits: this is a deterministic WAV replay, not a browser/device-output test. RMS frames identify coarse phrase pauses only; Realtime provides no exact word timestamps, and Whisper timings are an independent approximate reference.");
