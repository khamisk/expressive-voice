import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const runIdArgument = process.argv.find((argument) => argument.startsWith("--run-id="));
const runId = runIdArgument?.slice("--run-id=".length) || "";
if (runId && !/^[a-z0-9_-]+$/iu.test(runId)) {
  throw new Error("--run-id must contain only letters, numbers, underscores, or hyphens.");
}
const outputDirectory = path.join(
  projectDirectory,
  "public",
  "performance",
  "timing-audit",
  ...(runId ? [runId] : []),
);

// Keep credentials in .env.local. This script never logs the key or accepts it
// as a command-line argument.
dotenv.config({ path: path.join(projectDirectory, ".env.local"), override: true, quiet: true });

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const voice = process.env.OPENAI_REALTIME_VOICE ?? "cedar";
const sampleRate = 24_000;
const bytesPerSample = 2;
const maxClipSeconds = 18;
const maxTotalSeconds = 35;
const requestTimeoutMs = 45_000;
const skipWhisper = process.argv.includes("--skip-whisper");

const sessionInstructions = [
  "You are a friendly, natural voice in a short conversation.",
  "Speak like a real person, not a narrator or an advertisement.",
  "Keep the requested wording exact.",
  "Use a small amount of warmth and natural pacing.",
].join("\n");

const clips = [
  {
    id: "side-question",
    filename: "side-question.wav",
    expectedText: "What’s going on on your side?",
    responseInstructions: [
      "Say this exact sentence.",
      "Sound curious and warm.",
      "Let the question land naturally.",
      "Do not add any other words.",
      "What’s going on on your side?",
    ].join("\n"),
  },
  {
    id: "empathy-correction",
    filename: "empathy-correction.wav",
    expectedText: "I was wrong about that. Thanks for catching it. That sounds frustrating, but we can fix it together.",
    responseInstructions: [
      "Say these three complete sentences exactly.",
      "Sound sincere, calm, and conversational.",
      "Give the correction a small pause before the empathy.",
      "Do not add any other words.",
      "I was wrong about that.",
      "Thanks for catching it.",
      "That sounds frustrating, but we can fix it together.",
    ].join("\n"),
  },
];

function send(socket, event) {
  socket.send(JSON.stringify(event));
}

function asText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function wavHeader(dataLength, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function makeWav(pcmChunks) {
  const audio = Buffer.concat(pcmChunks);
  if (audio.length === 0 || audio.length % bytesPerSample !== 0) {
    throw new Error("Realtime returned an empty or malformed PCM stream.");
  }
  return Buffer.concat([wavHeader(audio.length, sampleRate), audio]);
}

function normalizeWords(text) {
  return (text.toLocaleLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? []).join(" ");
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close();
  } catch {
    // The request result is already determined; a close failure is harmless.
  }
}

function recordClip(clip, totalPcmSamplesBefore) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    let socket;
    let opened = false;
    let settled = false;
    let timer;
    let eventIndex = 0;
    let transcript = "";
    let responseId = null;
    let pcmSamples = 0;
    const pcmChunks = [];
    const timeline = [];
    const audioDeltas = [];
    const transcriptDeltas = [];
    const startedAt = performance.now();

    const elapsedMs = () => Number((performance.now() - startedAt).toFixed(3));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket(socket);
      if (error) reject(error);
      else resolve(result);
    };

    timer = setTimeout(() => finish(new Error(`Timed out while auditing ${clip.id}.`)), requestTimeoutMs);

    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    socket.addEventListener("open", () => {
      opened = true;
      send(socket, {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: sessionInstructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: sampleRate },
              turn_detection: null,
            },
            output: {
              format: { type: "audio/pcm", rate: sampleRate },
              voice,
            },
          },
          max_output_tokens: 512,
        },
      });
      send(socket, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Say this exact line or lines:\n${clip.expectedText}` }],
        },
      });
      send(socket, {
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: clip.responseInstructions,
        },
      });
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(asText(event.data));
      } catch {
        finish(new Error("Realtime returned a non-JSON event."));
        return;
      }

      const elapsed = elapsedMs();
      const baseEvent = {
        index: eventIndex++,
        type: message.type ?? "unknown",
        elapsedMs: elapsed,
        pcmSamplesCumulative: pcmSamples,
      };

      if (message.type === "error") {
        const detail = message.error?.code ?? message.error?.type ?? "Realtime returned an error.";
        finish(new Error(`Realtime returned ${detail}.`));
        return;
      }

      if (message.type === "response.created") responseId = message.response?.id ?? null;

      if (message.type === "response.output_audio.delta" && message.delta) {
        let audio;
        try {
          audio = Buffer.from(message.delta, "base64");
        } catch {
          finish(new Error("Realtime returned an invalid audio delta."));
          return;
        }
        if (audio.length === 0 || audio.length % bytesPerSample !== 0) {
          finish(new Error("Realtime returned an audio delta with an invalid PCM length."));
          return;
        }
        const deltaSamples = audio.length / bytesPerSample;
        pcmChunks.push(audio);
        pcmSamples += deltaSamples;
        const detail = {
          ...baseEvent,
          deltaSamples,
          pcmSamplesCumulative: pcmSamples,
          audioOffsetMs: Number((pcmSamples / sampleRate * 1000).toFixed(3)),
        };
        audioDeltas.push(detail);
        timeline.push({ ...detail });
        if ((totalPcmSamplesBefore + pcmSamples) / sampleRate > maxTotalSeconds) {
          finish(new Error(`Audit audio exceeded the ${maxTotalSeconds}s total safety limit.`));
          return;
        }
        if (pcmSamples / sampleRate > maxClipSeconds) {
          finish(new Error(`Audit clip ${clip.id} exceeded the ${maxClipSeconds}s safety limit.`));
          return;
        }
      }

      if (
        message.type === "response.output_audio_transcript.delta"
        || message.type === "response.audio_transcript.delta"
      ) {
        const delta = typeof message.delta === "string" ? message.delta : "";
        transcript += delta;
        const detail = {
          ...baseEvent,
          delta,
          transcriptCumulative: transcript,
          transcriptCharsCumulative: transcript.length,
        };
        transcriptDeltas.push(detail);
        timeline.push({ ...detail });
      }

      if (message.type === "response.done") {
        const status = message.response?.status;
        if (status && status !== "completed") {
          finish(new Error(`Realtime response ended with status ${status}.`));
          return;
        }
        try {
          finish(null, {
            wav: makeWav(pcmChunks),
            pcmSamples,
            pcmBytes: pcmSamples * bytesPerSample,
            durationSeconds: pcmSamples / sampleRate,
            transcript,
            responseId,
            timeline,
            audioDeltas,
            transcriptDeltas,
            elapsedMs: elapsed,
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    socket.addEventListener("error", () => {
      finish(new Error(opened ? `Realtime socket failed while auditing ${clip.id}.` : "Could not connect to the Realtime API."));
    });

    socket.addEventListener("close", () => {
      if (!settled) finish(new Error(`Realtime socket closed before ${clip.id} completed.`));
    });
  });
}

async function transcribeWithWordTimestamps(wav, filename, prompt) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("prompt", prompt);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`Whisper transcription failed (${response.status}).`);
  const transcription = await response.json();
  return {
    text: typeof transcription.text === "string" ? transcription.text : "",
    words: Array.isArray(transcription.words)
      ? transcription.words
        .filter((word) => typeof word?.word === "string" && Number.isFinite(word?.start) && Number.isFinite(word?.end))
        .map((word) => ({
          word: word.word,
          startMs: Math.round(word.start * 1000),
          endMs: Math.round(word.end * 1000),
        }))
      : [],
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

async function writeNew(filePath, contents) {
  if (await pathExists(filePath)) {
    throw new Error(`Refusing to overwrite existing audit artifact: ${path.basename(filePath)}.`);
  }
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

function summarizeClip(clip, result, whisper) {
  const transcriptText = result.transcript.trim();
  const firstTranscript = result.transcriptDeltas[0] ?? null;
  const lastTranscript = result.transcriptDeltas.at(-1) ?? null;
  const normalizedExpected = normalizeWords(clip.expectedText);
  const normalizedRealtime = normalizeWords(transcriptText);
  const normalizedWhisper = normalizeWords(whisper?.text ?? "");
  return {
    id: clip.id,
    filename: clip.filename,
    expectedText: clip.expectedText,
    responseInstructions: clip.responseInstructions,
    transcript: transcriptText,
    transcriptMatchesExpected: normalizedRealtime === normalizedExpected,
    transcriptNewlineCount: (result.transcript.match(/\n/g) ?? []).length,
    instructionNewlineCount: (clip.responseInstructions.match(/\n/g) ?? []).length,
    responseId: result.responseId,
    sampleRate,
    pcmSamples: result.pcmSamples,
    pcmBytes: result.pcmBytes,
    durationSeconds: Number(result.durationSeconds.toFixed(3)),
    streamElapsedMs: result.elapsedMs,
    audioDeltaCount: result.audioDeltas.length,
    transcriptDeltaCount: result.transcriptDeltas.length,
    firstAudioDeltaMs: result.audioDeltas[0]?.elapsedMs ?? null,
    firstTranscriptDeltaMs: firstTranscript?.elapsedMs ?? null,
    lastAudioDeltaMs: result.audioDeltas.at(-1)?.elapsedMs ?? null,
    lastTranscriptDeltaMs: lastTranscript?.elapsedMs ?? null,
    firstTranscriptAudioSamples: firstTranscript?.pcmSamplesCumulative ?? null,
    lastTranscriptAudioSamples: lastTranscript?.pcmSamplesCumulative ?? null,
    firstTranscriptAudioOffsetMs: firstTranscript
      ? Number((firstTranscript.pcmSamplesCumulative / sampleRate * 1000).toFixed(3))
      : null,
    lastTranscriptAudioOffsetMs: lastTranscript
      ? Number((lastTranscript.pcmSamplesCumulative / sampleRate * 1000).toFixed(3))
      : null,
    whisper: whisper
      ? {
          text: whisper.text,
          normalizedTextMatchesExpected: normalizedWhisper === normalizedExpected,
          words: whisper.words,
        }
      : null,
    timeline: result.timeline,
    audioDeltas: result.audioDeltas,
    transcriptDeltas: result.transcriptDeltas,
  };
}

function buildReport(manifest) {
  const lines = [
    "# Realtime speech timing audit",
    "",
    `Generated ${manifest.generatedAt} with ${manifest.model} and ${manifest.voice}.`,
    "",
    "This is a Node-native provider stream audit. `elapsedMs` is the local arrival time of a WebSocket event; `pcmSamplesCumulative` is audio received so far, converted to an approximate audio offset at 24 kHz. Neither is a perfect playback clock or word timestamp.",
    "",
    "## Clips",
    "",
    "| Clip | Audio | Realtime transcript | Newlines in instructions → transcript | Audio deltas | Transcript deltas | First transcript (arrival / audio offset) |",
    "| --- | ---: | --- | ---: | ---: | ---: | --- |",
  ];
  for (const clip of manifest.clips) {
    const first = clip.firstTranscriptDeltaMs === null
      ? "none"
      : `${clip.firstTranscriptDeltaMs.toFixed(1)} ms / ${(clip.firstTranscriptAudioOffsetMs ?? 0).toFixed(1)} ms`;
    lines.push(`| ${clip.id} | ${clip.durationSeconds.toFixed(2)}s | ${clip.transcriptMatchesExpected ? "matches" : "differs"} | ${clip.instructionNewlineCount} → ${clip.transcriptNewlineCount} | ${clip.audioDeltaCount} | ${clip.transcriptDeltaCount} | ${first} |`);
  }
  lines.push(
    "",
    "## What the stream proves",
    "",
    "- Every captured audio delta includes its PCM sample count and cumulative sample total.",
    "- Every captured output transcript delta includes local arrival time and the cumulative PCM samples already received when it arrived.",
    "- The response instructions contained line breaks between complete thoughts. The returned audio transcript newline count is recorded per clip; this tells us whether the provider emitted newline characters in transcript deltas, not whether the spoken audio had audible line breaks.",
    "- Whisper word timestamps, when present, are an independent approximate alignment reference over the saved WAV. They are not the Realtime model's own word clock.",
    "",
    "## Reproduction",
    "",
    "Run `node scripts/audit-speech-timing.mjs --run-id=another-run --skip-whisper` to repeat without the optional transcription pass. The script refuses to overwrite existing audit artifacts and enforces an 18-second clip / 35-second total audio safety limit.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing from .env.local.");
  await fs.mkdir(outputDirectory, { recursive: true });

  const generated = [];
  let totalPcmSamples = 0;
  for (const clip of clips) {
    process.stdout.write(`Auditing ${clip.id} with ${model}/${voice}... `);
    let result;
    try {
      result = await recordClip(clip, totalPcmSamples);
    } catch (error) {
      throw new Error(`${clip.id}: ${safeError(error)}`);
    }
    totalPcmSamples += result.pcmSamples;

    let whisper = null;
    if (!skipWhisper) {
      try {
        whisper = await transcribeWithWordTimestamps(
          result.wav,
          clip.filename,
          clip.expectedText,
        );
      } catch (error) {
        whisper = { error: safeError(error), text: "", words: [] };
      }
    }

    await writeNew(path.join(outputDirectory, clip.filename), result.wav);
    generated.push(summarizeClip(clip, result, whisper));
    console.log(`${result.durationSeconds.toFixed(2)}s, ${result.transcriptDeltas.length} transcript deltas, ${result.audioDeltas.length} audio deltas`);
  }

  const manifest = {
    kind: "realtime-speech-timing-audit",
    generatedAt: new Date().toISOString(),
    model,
    voice,
    sampleRate,
    channels: 1,
    encoding: "pcm_s16le",
    totalDurationSeconds: Number((totalPcmSamples / sampleRate).toFixed(3)),
    whisperRequested: !skipWhisper,
    safetyLimits: { maxClipSeconds, maxTotalSeconds },
    clips: generated,
  };
  await writeNew(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeNew(path.join(outputDirectory, "report.md"), buildReport(manifest));
  console.log(`Wrote timing audit artifacts to ${path.relative(projectDirectory, outputDirectory)}.`);
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
