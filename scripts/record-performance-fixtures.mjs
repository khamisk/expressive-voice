import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(projectDirectory, "public", "performance");

// Keep the API key in the local environment. This script never logs it and does
// not accept it as a command-line argument.
dotenv.config({ path: path.join(projectDirectory, ".env.local"), override: true, quiet: true });

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const voice = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const sampleRate = 24_000;
const maxAttempts = 2;
const callTimeoutMs = 60_000;

const recordingInstructions = [
  "You are recording a short voice performance reference for a friendly conversational character.",
  "Speak the requested line exactly, with no introduction, explanation, or extra words.",
  "Use natural contractions and conversational timing. Do not sound like a narrator or an advertisement.",
].join(" ");

const fixtures = [
  {
    id: "curious",
    text: "Wait, you built that yourself? How did you get it to work?",
    delivery: "Sound genuinely curious. Let the first realization land, then ask the question with bright interest.",
  },
  {
    id: "celebration",
    text: "You got it! Oh, that is such good news. You earned this.",
    delivery: "Sound warmly excited, with a quick burst of delight followed by sincere warmth. Keep it grounded, not performative.",
  },
  {
    id: "playful",
    text: "Very convincing. I am almost certain you did not make that up.",
    delivery: "Sound dry and teasing, with a small amused pause after the first sentence. Do not overplay the joke.",
  },
  {
    id: "gentle",
    text: "That sounds exhausting. Want to talk about what happened?",
    delivery: "Sound gentle and attentive. Slow slightly and leave room around the question without sounding solemn or scripted.",
  },
];

const phraseFixtures = [
  {
    id: "surprise-empathy-interest",
    title: "Surprise, then care",
    prompt: "I finished a difficult project in one night.",
    text: "Wait, you did all that in one night? That's a lot to have on your plate. No wonder that stuck with you. How did it actually turn out?",
    delivery:
      "Perform three clear emotional beats in one natural reply: genuine surprise on the first question, soft grounded empathy through the middle, then an interested and open question at the end. Let each beat breathe without becoming theatrical.",
    cues: [
      {
        text: "Wait, you did all that in one night?",
        expression: "surprised",
        gesture: "lean-in",
        intensity: 0.9,
      },
      {
        text: "That's a lot to have on your plate. No wonder that stuck with you.",
        expression: "concerned",
        gesture: "settle",
        intensity: 0.62,
      },
      {
        text: "How did it actually turn out?",
        expression: "curious",
        gesture: "tilt-right",
        intensity: 0.74,
      },
    ],
    initialEffectScene: "none",
  },
  {
    id: "disbelief-joy-tease",
    title: "Disbelief, then delight",
    prompt: "My impossible-looking prototype finally works.",
    text: "Hold on, you actually got it working? Oh, that's fantastic. I was fully prepared to call that a very ambitious theory. You can be smug about this one.",
    delivery:
      "Perform three clear emotional beats in one natural reply: playful disbelief at first, a bright sincere burst of joy in the middle, then affectionate teasing at the end. Keep the delight quick and the teasing dry, not exaggerated.",
    cues: [
      {
        text: "Hold on, you actually got it working?",
        expression: "skeptical",
        gesture: "tilt-left",
        intensity: 0.82,
      },
      {
        text: "Oh, that's fantastic.",
        expression: "delighted",
        gesture: "lift",
        intensity: 0.92,
      },
      {
        text: "I was fully prepared to call that a very ambitious theory. You can be smug about this one.",
        expression: "playful",
        gesture: "settle",
        intensity: 0.78,
      },
    ],
    initialEffectScene: "celebration-confetti",
  },
];

const phraseOnly = process.argv.includes("--phrases-only");
const finalizeExistingPhrases = process.argv.includes("--finalize-existing-phrases");
const selectedFixtures = phraseOnly ? phraseFixtures : fixtures;

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
  header.writeUInt32LE(rate * 2, 28); // mono, 16-bit
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function toWav(pcmChunks) {
  const audio = Buffer.concat(pcmChunks);
  if (audio.length === 0 || audio.length % 2 !== 0) {
    throw new Error("Realtime returned an empty or malformed PCM stream.");
  }
  return { audio, wav: Buffer.concat([wavHeader(audio.length, sampleRate), audio]) };
}

function normalizeWords(text) {
  return (text.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? []).join(" ");
}

function findWordRange(words, phrase, fromIndex) {
  const expected = normalizeWords(phrase).split(" ").filter(Boolean);
  for (let start = fromIndex; start <= words.length - expected.length; start += 1) {
    const matches = expected.every((token, offset) => normalizeWords(words[start + offset].word) === token);
    if (matches) {
      const end = start + expected.length - 1;
      return { start, end };
    }
  }
  throw new Error(`Whisper word timestamps did not match the authored phrase: ${phrase}`);
}

function makePhraseCues(fixture, words) {
  let fromIndex = 0;
  return fixture.cues.map((cue) => {
    const range = findWordRange(words, cue.text, fromIndex);
    fromIndex = range.end + 1;
    return {
      atMs: Math.round(words[range.start].start * 1000),
      endMs: Math.round(words[range.end].end * 1000),
      expression: cue.expression,
      gesture: cue.gesture,
      intensity: cue.intensity ?? 0.8,
      text: cue.text,
    };
  });
}

async function transcribeWithWordTimestamps(wav, filename) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Whisper transcription failed (${response.status}).`);
  }
  const transcription = await response.json();
  if (!Array.isArray(transcription.words) || transcription.words.length === 0) {
    throw new Error("Whisper did not return word timestamps for the phrase fixture.");
  }
  return transcription;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close();
  } catch {
    // The request result is already determined; a close failure is harmless.
  }
}

function recordOnce(fixture) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    let socket;
    let opened = false;
    let settled = false;
    let timer;
    const pcmChunks = [];
    let transcript = "";
    let responseId = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket(socket);
      if (error) reject(error);
      else resolve(result);
    };

    timer = setTimeout(() => finish(new Error(`Timed out while recording ${fixture.id}.`)), callTimeoutMs);

    try {
      socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
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
          instructions: recordingInstructions,
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
          max_output_tokens: 256,
        },
      });
      send(socket, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Say this line: ${fixture.text}` }],
        },
      });
      send(socket, {
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: `${fixture.delivery} Say exactly: ${fixture.text}`,
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

      if (message.type === "error") {
        const detail = message.error?.message ?? "Realtime returned an error.";
        finish(new Error(detail));
        return;
      }

      if (message.type === "response.created") {
        responseId = message.response?.id ?? null;
      }

      if (message.type === "response.output_audio.delta" && message.delta) {
        pcmChunks.push(Buffer.from(message.delta, "base64"));
      }

      if (
        message.type === "response.output_audio_transcript.delta" ||
        message.type === "response.audio_transcript.delta"
      ) {
        transcript += message.delta ?? "";
      }

      if (message.type === "response.done") {
        const status = message.response?.status;
        if (status && status !== "completed") {
          finish(new Error(`Realtime response ended with status ${status}.`));
          return;
        }
        try {
          const { audio, wav } = toWav(pcmChunks);
          finish(null, {
            wav,
            pcmBytes: audio.length,
            durationSeconds: audio.length / (sampleRate * 2),
            transcript: transcript.trim(),
            responseId,
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    socket.addEventListener("error", () => {
      finish(new Error(opened ? `Realtime socket failed while recording ${fixture.id}.` : "Could not connect to the Realtime API."));
    });

    socket.addEventListener("close", () => {
      if (!settled) finish(new Error(`Realtime socket closed before ${fixture.id} completed.`));
    });
  });
}

async function recordWithRetry(fixture) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await recordOnce(fixture);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        console.warn(`Retrying ${fixture.id} after attempt ${attempt} failed.`);
      }
    }
  }
  throw lastError;
}

async function main() {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing from .env.local.");
  }
  if (finalizeExistingPhrases && !phraseOnly) {
    throw new Error("--finalize-existing-phrases must be used with --phrases-only.");
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const existingManifest = phraseOnly && (await pathExists(manifestPath))
    ? JSON.parse(await fs.readFile(manifestPath, "utf8"))
    : null;
  let fixturesToProcess = selectedFixtures;
  if (finalizeExistingPhrases) {
    fixturesToProcess = [];
    for (const fixture of phraseFixtures) {
      if (await pathExists(path.join(outputDirectory, `${fixture.id}.wav`))) {
        fixturesToProcess.push(fixture);
      }
    }
  }

  const recordings = [];

  for (const fixture of fixturesToProcess) {
    const filename = `${fixture.id}.wav`;
    const filePath = path.join(outputDirectory, filename);
    let result;
    if (phraseOnly && await pathExists(filePath)) {
      process.stdout.write(`Using existing ${fixture.id}... `);
      const wav = await fs.readFile(filePath);
      if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`Existing phrase fixture ${filename} is not a valid WAV file.`);
      }
      const pcmBytes = wav.readUInt32LE(40);
      result = { wav, pcmBytes, durationSeconds: pcmBytes / (sampleRate * 2), transcript: "" };
    } else {
      process.stdout.write(`Recording ${fixture.id}... `);
      result = await recordWithRetry(fixture);
    }
    let transcription = null;
    let cues = null;
    if (phraseOnly) {
      transcription = await transcribeWithWordTimestamps(result.wav, filename);
      if (normalizeWords(transcription.text ?? "") !== normalizeWords(fixture.text)) {
        throw new Error(`Whisper text did not match the authored text for ${fixture.id}.`);
      }
      cues = makePhraseCues(fixture, transcription.words);
    }
    if (!(phraseOnly && await pathExists(filePath))) {
      await fs.writeFile(filePath, result.wav);
    }
    recordings.push({
      id: fixture.id,
      ...(phraseOnly ? { title: fixture.title, prompt: fixture.prompt } : {}),
      filename,
      text: fixture.text,
      model,
      voice,
      sampleRate,
      channels: 1,
      encoding: "pcm_s16le",
      durationSeconds: Number(result.durationSeconds.toFixed(3)),
      pcmBytes: result.pcmBytes,
      generatedBy: "OpenAI Realtime API over WebSocket",
      transcript: result.transcript || (phraseOnly ? transcription.text : null),
      ...(phraseOnly
        ? {
            whisperModel: "whisper-1",
            whisperText: transcription.text,
            wordTimestamps: transcription.words.map((word) => ({
              word: word.word,
              startMs: Math.round(word.start * 1000),
              endMs: Math.round(word.end * 1000),
            })),
            cues,
            initialEffectScene: fixture.initialEffectScene,
            cueSource: "explicitly-authored-visual-study-not-live-model-confidence",
          }
        : {}),
    });
    console.log(`${recordings.at(-1).durationSeconds.toFixed(2)}s`);
  }

  const existingRecordings = existingManifest?.recordings ?? [];
  const newIds = new Set(recordings.map((recording) => recording.id));
  const allRecordings = [...existingRecordings.filter((recording) => !newIds.has(recording.id)), ...recordings];
  const manifest = phraseOnly
    ? {
        ...existingManifest,
        generatedAt: new Date().toISOString(),
        model,
        voice,
        sampleRate,
        totalDurationSeconds: Number(allRecordings.reduce((total, recording) => total + recording.durationSeconds, 0).toFixed(3)),
        recordings: allRecordings,
      }
    : {
        kind: "developer-performance-fixtures",
        purpose: "Short real voice recordings for auditioning the eye-only character performance.",
        generatedAt: new Date().toISOString(),
        model,
        voice,
        sampleRate,
        totalDurationSeconds: Number(recordings.reduce((total, recording) => total + recording.durationSeconds, 0).toFixed(3)),
        recordings,
      };

  await fs.writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${recordings.length} WAV fixtures and manifest.json to public/performance.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
