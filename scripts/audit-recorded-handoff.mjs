import { readFileSync } from "node:fs";
import { TalkOverController } from "../src/lib/turn-taking.ts";
import { SpeechTimeline } from "../src/lib/caption-clock.ts";
import { captionWords, speechPunctuation } from "../src/lib/spoken-caption.ts";

// Offline, read-only replay of existing provider recordings. No browser,
// microphone, speaker, network, credentials, or new generated audio. Input
// overlap is simulated; Whisper offsets are an independent approximate
// reference, NOT timestamps available to the production Realtime client.
const directory = new URL("../public/performance/timing-audit/final-2026-08-27/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));

function audioWindows(filename) {
  if (!/^[a-z-]+\.wav$/u.test(filename)) throw new Error("Unexpected recording filename.");
  const wav = readFileSync(new URL(filename, directory));
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid WAV.");
  let sampleRate = 0;
  let pcm;
  for (let at = 12; at + 8 <= wav.length;) {
    const type = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const from = at + 8;
    if (from + size > wav.length) throw new Error("Incomplete WAV chunk.");
    if (type === "fmt ") {
      if (wav.readUInt16LE(from) !== 1 || wav.readUInt16LE(from + 2) !== 1 || wav.readUInt16LE(from + 14) !== 16) throw new Error("Expected mono s16 PCM.");
      sampleRate = wav.readUInt32LE(from + 4);
    }
    if (type === "data") pcm = wav.subarray(from, from + size);
    at = from + size + (size % 2);
  }
  if (!pcm || sampleRate !== 24_000) throw new Error("Unexpected recording format.");
  const windowSamples = sampleRate / 50;
  const windows = [];
  for (let from = 0; from < pcm.length / 2; from += windowSamples) {
    const to = Math.min(pcm.length / 2, from + windowSamples);
    let squares = 0;
    for (let index = from; index < to; index += 1) squares += (pcm.readInt16LE(index * 2) / 32768) ** 2;
    windows.push(Math.sqrt(squares / (to - from)));
  }
  return { windows, durationMs: pcm.length / 2 / sampleRate * 1000 };
}

function replay(clip, overlap, boundaryMode) {
  const { windows, durationMs } = audioWindows(clip.filename);
  const words = captionWords(clip.transcript);
  if (clip.whisper.words.length !== words.length) throw new Error("Reference word count differs; cannot align this clip by index.");
  const referenceBoundaries = clip.whisper.words.flatMap((word, index) => {
    const punctuation = speechPunctuation(words[index]);
    return punctuation === "none" ? [] : [{ at: word.endMs, boundary: punctuation === "comma" ? "phrase" : "sentence" }];
  });
  const firstAudibleAt = windows.findIndex((rms) => rms >= 0.005) * 20;
  const timeline = new SpeechTimeline();
  timeline.updateText(clip.transcript, true);
  timeline.setDuration(durationMs);
  const policy = new TalkOverController();
  let audible = false;
  let wasAudible = false;
  let quietSince = null;
  let pendingBoundary = null;

  for (let at = 0; at <= durationMs + 320; at += 16) {
    const rms = windows[Math.floor(at / 20)] ?? 0;
    audible = rms >= (audible ? 0.0035 : 0.005);
    if (audible) { wasAudible = true; quietSince = null; }
    else quietSince ??= at;
    const elapsed = Math.max(0, at - firstAudibleAt);
    let boundary;
    let nextBoundaryAt;
    if (boundaryMode === "recorded-reference") {
      boundary = referenceBoundaries.find((entry) => entry.at <= at && entry.at > at - 16)?.boundary;
      nextBoundaryAt = referenceBoundaries.find((entry) => entry.at > at)?.at;
    } else {
      if (wasAudible) timeline.observeAudio(elapsed, audible);
      for (const word of timeline.advance(elapsed)) {
        const punctuation = speechPunctuation(word.text);
        if (punctuation !== "none" && word.endMs >= elapsed) pendingBoundary = {
          at: firstAudibleAt + word.endMs,
          boundary: punctuation === "comma" ? "phrase" : "sentence",
        };
      }
      if (pendingBoundary && pendingBoundary.at <= at) {
        boundary = pendingBoundary.boundary;
        pendingBoundary = null;
      }
      const upcoming = timeline.words.find((word) => word.endMs > elapsed && speechPunctuation(word.text) !== "none");
      nextBoundaryAt = upcoming ? firstAudibleAt + upcoming.endMs : undefined;
    }
    const started = at >= overlap.at;
    const completed = at >= overlap.at + 620;
    const decision = policy.update({
      nowMs: at,
      userSpeechActive: started && !completed,
      inputLevel: started && !completed ? 0.1 : 0,
      userTranscript: at >= overlap.at + 300 ? overlap.text : "",
      userTranscriptComplete: completed,
      userPaused: completed,
      assistantGenerating: false,
      assistantAudioPlaying: at < durationMs,
      outputQuiet: wasAudible && quietSince !== null && at - quietSince >= 160,
      outputBoundary: boundary,
      outputBoundaryAt: nextBoundaryAt,
    });
    if (decision.handoff) {
      const duringWord = clip.whisper.words.find((word) => word.startMs < at && word.endMs > at);
      return {
        clip: clip.id, scenario: overlap.id, boundaryMode, overlapStartsMs: overlap.at,
        handoffMs: at, reason: decision.reason, fadeEndsMs: at + (decision.fadeMs ?? 0),
        referenceWordAtFadeStart: duringWord?.word ?? null,
        outputAudibleAtFadeStart: audible,
      };
    }
  }
  return { clip: clip.id, scenario: overlap.id, boundaryMode, handoffMs: null, result: "old audio finished without a forced handoff" };
}

const scenarios = [
  { clip: "side-question", id: "new-topic-early", at: 100, text: "Can we talk about dinner instead?" },
  { clip: "side-question", id: "brief-yeah", at: 100, text: "yeah" },
  { clip: "empathy-correction", id: "new-topic-first-thought", at: 650, text: "What should I cook tonight?" },
  { clip: "empathy-correction", id: "new-topic-later-clause", at: 4200, text: "Tell me about the moon instead." },
];
console.log("Offline recorded-audio handoff audit. PCM silence is measured; user overlap is simulated; word alignment is approximate.");
for (const scenario of scenarios) {
  const clip = manifest.clips.find((entry) => entry.id === scenario.clip);
  if (!clip) throw new Error("Missing recorded fixture.");
  for (const mode of ["recorded-reference", "estimated-timeline"]) console.log(JSON.stringify(replay(clip, scenario, mode)));
}
