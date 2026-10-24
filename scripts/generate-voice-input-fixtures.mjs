import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(projectDirectory, "public", "voice-input");
const manifestPath = path.join(outputDirectory, "manifest.json");

// This is a local developer tool. The key is read only from .env.local and is
// never printed, written to an asset, or accepted as a command-line argument.
dotenv.config({ path: path.join(projectDirectory, ".env.local"), override: true, quiet: true });

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const voice = process.env.OPENAI_TTS_VOICE ?? process.env.OPENAI_REALTIME_VOICE ?? "cedar";
const speed = Number.isFinite(Number(process.env.OPENAI_TTS_SPEED))
  ? Math.max(0.25, Math.min(4, Number(process.env.OPENAI_TTS_SPEED)))
  : 0.98;
const maxAttemptsPerClip = 2;
const maxTotalDurationSeconds = 40;
const timeoutMs = 60_000;
const overwrite = process.argv.includes("--overwrite");

const fixtures = [
  {
    id: "yeah",
    intent: "brief_acknowledgment",
    text: "Yeah.",
    delivery: "A quick, natural acknowledgment. Warm and present, not enthusiastic or drawn out.",
  },
  {
    id: "substantive-correction",
    intent: "correct_previous_statement",
    text: "Actually, I got that wrong. It was a rejection, not a win.",
    delivery: "Sound like a person correcting themselves mid-conversation. Start matter-of-fact, then let the disappointment register briefly.",
  },
  {
    id: "stop-and-repeat",
    intent: "interrupt_and_request_repeat",
    text: "Hold on, stop there. Can you say that again?",
    delivery: "A clear but friendly interruption. Keep it conversational, with a small pause before the repeat request.",
  },
  {
    id: "job-win",
    intent: "positive_personal_news",
    text: "I finally got the job I really wanted. I am so happy right now.",
    delivery: "Genuinely happy and relieved. Let the realization arrive before the second sentence; avoid an advertisement-like performance.",
  },
  {
    id: "disappointing-correction",
    intent: "negative_personal_news",
    text: "I need to correct that. I did not get the job after all, and it really hurts.",
    delivery: "Quietly disappointed and honest. Begin with the correction, then soften into the last clause without becoming theatrical.",
  },
  {
    id: "changing-intent-story",
    intent: "short_story_with_changing_intent",
    text: "A fox finds a tiny door, gets curious, then backs away when it hears a laugh inside.",
    delivery: "Tell this as a tiny story with three shifts: wonder at the door, curious attention, then a surprised retreat at the laugh. Keep it compact and natural.",
  },
];

function wavInfo(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The speech endpoint did not return a RIFF/WAVE file.");
  }

  let offset = 12;
  let format = null;
  let dataLength = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    // Some WAV writers leave a stale RIFF/chunk size after a trailing metadata
    // block. Treat that as a bounded file-size issue and still inspect the
    // audio chunks; never read past the bytes returned by the API.
    const availableLength = Math.max(0, bytes.length - chunkStart);
    if (chunkId === "fmt " && chunkLength >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkId === "data") dataLength = Math.min(chunkLength, availableLength);
    const boundedLength = Math.min(chunkLength, availableLength);
    offset = chunkStart + boundedLength + (boundedLength % 2);
    if (boundedLength < chunkLength) break;
  }
  if (!format || dataLength === null || format.channels < 1 || format.sampleRate < 1 || format.bitsPerSample < 1) {
    throw new Error("The returned WAV is missing usable PCM metadata.");
  }
  const bytesPerSample = format.bitsPerSample / 8;
  const durationSeconds = dataLength / (format.sampleRate * format.channels * bytesPerSample);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("The returned WAV has no audio duration.");
  return {
    ...format,
    dataBytes: dataLength,
    durationSeconds,
    encoding: format.audioFormat === 1 ? `pcm_s${format.bitsPerSample}le` : `wav_format_${format.audioFormat}`,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requestSpeech(fixture) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: fixture.text,
        voice,
        instructions: fixture.delivery,
        response_format: "wav",
        speed,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Speech generation failed for ${fixture.id} (${response.status}).`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    const info = wavInfo(audio);
    return { audio, info };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithRetry(fixture) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttemptsPerClip; attempt += 1) {
    try {
      return await requestSpeech(fixture);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttemptsPerClip) {
        console.warn(`Retrying ${fixture.id} once after the first request failed.`);
      }
    }
  }
  throw lastError;
}

function recordingFrom(fixture, info, filename, generated) {
  return {
    id: fixture.id,
    intent: fixture.intent,
    filename,
    relativeURL: `/voice-input/${filename}`,
    text: fixture.text,
    durationSeconds: Number(info.durationSeconds.toFixed(3)),
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    encoding: info.encoding,
    dataBytes: info.dataBytes,
    generatedBy: generated,
    syntheticInput: true,
    isMockResponse: false,
    physicalMicrophoneTest: false,
  };
}

async function main() {
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing from .env.local.");
  await fs.mkdir(outputDirectory, { recursive: true });

  let existingManifest = null;
  if (await pathExists(manifestPath)) {
    try {
      existingManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      throw new Error("public/voice-input/manifest.json is not valid JSON.");
    }
  }
  const existingById = new Map((existingManifest?.recordings ?? []).map((recording) => [recording.id, recording]));
  const recordings = [];
  let totalDurationSeconds = 0;

  for (const fixture of fixtures) {
    const filename = `${fixture.id}.wav`;
    const filePath = path.join(outputDirectory, filename);
    let recording;
    if (!overwrite && await pathExists(filePath)) {
      const audio = await fs.readFile(filePath);
      const info = wavInfo(audio);
      recording = recordingFrom(fixture, info, filename, existingById.get(fixture.id)?.generatedBy ?? "OpenAI Audio Speech API");
      console.log(`Using existing ${filename} (${recording.durationSeconds.toFixed(2)}s).`);
    } else {
      process.stdout.write(`Generating ${filename}... `);
      const { audio, info } = await requestWithRetry(fixture);
      recording = recordingFrom(fixture, info, filename, "OpenAI Audio Speech API");
      await fs.writeFile(filePath, audio);
      console.log(`${recording.durationSeconds.toFixed(2)}s`);
    }
    totalDurationSeconds += recording.durationSeconds;
    if (totalDurationSeconds > maxTotalDurationSeconds) {
      throw new Error(`The six voice-input fixtures exceeded the ${maxTotalDurationSeconds}s total duration bound.`);
    }
    recordings.push(recording);
  }

  const manifest = {
    kind: "developer-audio-input-fixtures",
    purpose: "Small bounded set of synthetic spoken inputs for end-to-end WebRTC Realtime QA.",
    generatedAt: new Date().toISOString(),
    source: {
      provider: "OpenAI Audio Speech API",
      model,
      voice,
      speed,
    },
    limits: {
      maxClips: fixtures.length,
      maxTotalDurationSeconds,
      maxAttemptsPerClip,
    },
    notes: [
      "These are synthetic recorded test inputs, not mock assistant responses.",
      "They are sent into the WebRTC input track; they are not played through local speakers by the browser helper.",
      "This fixture set does not validate a physical microphone, room acoustics, echo cancellation, or talk-over timing from a human speaker.",
    ],
    totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
    recordings,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${recordings.length} bounded spoken input fixtures to public/voice-input.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
