import dotenv from "dotenv";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  BASELINE_VOICE_PERSONA_INSTRUCTIONS,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_TRANSCRIPTION_MODEL,
  VOICE_PERSONA_INSTRUCTIONS,
  buildRealtimeSessionConfig,
} from "../server/voice-persona.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
dotenv.config({
  path: path.join(projectDirectory, ".env.local"),
  override: true,
  quiet: true,
});

// This is a bounded provider stream study. It does not use a microphone,
// speaker, browser, or saved audio, and it never prints credentials.
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;
const voice = process.env.OPENAI_REALTIME_VOICE ?? DEFAULT_REALTIME_VOICE;
const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL;
const sampleRate = 24_000;
const bytesPerSample = 2;
const requestTimeoutMs = 20_000;
const shortCurrent = process.argv.includes("--short-current");
const maxTurnSeconds = shortCurrent ? 10 : 18;
const maxTotalSeconds = shortCurrent ? 16 : 45;
const RealtimeWebSocket = WebSocket as unknown as {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
};

type ConversationTurn = {
  id: string;
  category: string;
  text: string;
};

type TurnResult = {
  id: string;
  category: string;
  transcript: string;
  audioSeconds: number;
  responseElapsedMs: number;
  firstAudioMs: number | null;
  firstTranscriptMs: number | null;
  audioDeltaCount: number;
  transcriptDeltaCount: number;
  responseId: string | null;
  status: string | null;
  statusDetails: Record<string, any> | null;
  safetyCutoff: boolean;
  usage: unknown;
};

type PhaseResult = {
  name: "baseline" | "revised" | "current";
  turns: TurnResult[];
  totalAudioSeconds: number;
  sessionEcho: SessionEcho;
};

const baselineTurns: ConversationTurn[] = [
  {
    id: "baseline-factual",
    category: "everyday factual",
    text: "I'm making breakfast. Why does toast smell so good when it browns?",
  },
  {
    id: "baseline-correction",
    category: "correction",
    text: "Actually, I got that wrong earlier. The appointment is next Thursday, not tomorrow. Sorry, different thought.",
  },
];

const revisedTurns: ConversationTurn[] = [
  {
    id: "factual",
    category: "everyday factual",
    text: "I'm making breakfast. Why does toast smell so good when it browns?",
  },
  {
    id: "correction",
    category: "correction",
    text: "Actually, I got that wrong earlier. The appointment is next Thursday, not tomorrow. Sorry, different thought.",
  },
  {
    id: "joke",
    category: "joke",
    text: "Also, I told my code it needed a break, and it opened an issue.",
  },
  {
    id: "bad-news",
    category: "bad news",
    text: "On a more serious note, I got a rejection email after the final interview. I thought it went well.",
  },
];

const shortCurrentTurns: ConversationTurn[] = [
  {
    id: "short-current-bad-news",
    category: "bad news",
    text: "I got a rejection email after the final interview. I thought it went well.",
  },
  {
    id: "short-current-correction",
    category: "correction",
    text: "Actually, I got that date wrong. The appointment is next Thursday, not tomorrow.",
  },
];

function send(socket: WebSocket, event: Record<string, unknown>) {
  socket.send(JSON.stringify(event));
}

function asText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

function closeSocket(socket: WebSocket | undefined) {
  if (!socket || socket.readyState >= WebSocket.CLOSING) return;
  try {
    socket.close();
  } catch {
    // The result is already determined; a close failure is harmless.
  }
}

function parseMessage(event: MessageEvent): Record<string, any> {
  try {
    const parsed = JSON.parse(asText(event.data));
    if (!parsed || typeof parsed !== "object") throw new Error("non-object event");
    return parsed as Record<string, any>;
  } catch {
    throw new Error("Realtime returned a malformed event.");
  }
}

type SessionEcho = {
  exact: boolean;
  sentHash: string;
  echoedHash: string | null;
};

function hashInstructions(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex").slice(0, 16);
}

function waitForSession(socket: WebSocket, expectedInstructions: string): Promise<SessionEcho> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sentHash = hashInstructions(expectedInstructions);
    const timer = setTimeout(() => finish(new Error("Realtime session setup timed out.")), requestTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (error?: Error, result?: SessionEcho) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result ?? { exact: false, sentHash, echoedHash: null });
    };
    const onMessage = (event: MessageEvent) => {
      let message: Record<string, any>;
      try {
        message = parseMessage(event);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.type === "error") {
        const code = message.error?.code ?? message.error?.type ?? "unknown";
        finish(new Error(`Realtime session setup failed (${code}).`));
        return;
      }
      if (message.type === "session.updated") {
        const echoedInstructions = typeof message.session?.instructions === "string"
          ? message.session.instructions
          : null;
        finish(undefined, {
          exact: echoedInstructions === expectedInstructions,
          sentHash,
          echoedHash: echoedInstructions === null ? null : hashInstructions(echoedInstructions),
        });
      }
    };
    const onError = () => finish(new Error("Realtime socket failed during session setup."));
    const onClose = () => finish(new Error("Realtime socket closed during session setup."));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function requestTurn(
  socket: WebSocket,
  turn: ConversationTurn,
  phaseAudioBeforeSeconds: number,
  totalAudioBeforeSeconds: number,
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let transcript = "";
  let responseId: string | null = null;
  let status: string | null = null;
    let statusDetails: Record<string, any> | null = null;
    let usage: unknown = null;
    let audioBytes = 0;
    let audioDeltaCount = 0;
    let transcriptDeltaCount = 0;
    let firstAudioMs: number | null = null;
    let firstTranscriptMs: number | null = null;
    let safetyCutoff = false;
    const requestedAt = performance.now();
    const elapsedMs = () => Number((performance.now() - requestedAt).toFixed(1));

    const timer = setTimeout(
      () => finish(new Error(`${turn.id}: response timed out after ${requestTimeoutMs}ms.`)),
      requestTimeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      const audioSeconds = audioBytes / bytesPerSample / sampleRate;
      if (audioBytes === 0) {
        reject(new Error(`${turn.id}: completed without an audio delta.`));
        return;
      }
      resolve({
        id: turn.id,
        category: turn.category,
        transcript: transcript.trim(),
        audioSeconds: Number(audioSeconds.toFixed(3)),
        responseElapsedMs: elapsedMs(),
        firstAudioMs,
        firstTranscriptMs,
        audioDeltaCount,
        transcriptDeltaCount,
        responseId,
        status,
        statusDetails,
        safetyCutoff,
        usage,
      });
    };
    const onMessage = (event: MessageEvent) => {
      let message: Record<string, any>;
      try {
        message = parseMessage(event);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (message.type === "error") {
        const code = message.error?.code ?? message.error?.type ?? "unknown";
        finish(new Error(`${turn.id}: provider returned ${code}.`));
        return;
      }
      if (message.type === "response.created") {
        responseId = message.response?.id ?? null;
        return;
      }
      if (message.type === "response.output_audio.delta" || message.type === "response.audio.delta") {
        if (typeof message.delta !== "string") return;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(message.delta, "base64");
        } catch {
          finish(new Error(`${turn.id}: provider returned invalid audio.`));
          return;
        }
        if (bytes.length === 0 || bytes.length % bytesPerSample !== 0) {
          finish(new Error(`${turn.id}: provider returned malformed PCM.`));
          return;
        }
        firstAudioMs ??= elapsedMs();
        audioBytes += bytes.length;
        audioDeltaCount += 1;
        const audioSeconds = audioBytes / bytesPerSample / sampleRate;
        if (audioSeconds > maxTurnSeconds) {
          safetyCutoff = true;
          finish();
          return;
        }
        if (totalAudioBeforeSeconds + phaseAudioBeforeSeconds + audioSeconds > maxTotalSeconds) {
          safetyCutoff = true;
          finish();
          return;
        }
        return;
      }
      if (
        message.type === "response.output_audio_transcript.delta"
        || message.type === "response.audio_transcript.delta"
      ) {
        if (typeof message.delta !== "string") return;
        firstTranscriptMs ??= elapsedMs();
        transcript += message.delta;
        transcriptDeltaCount += 1;
        return;
      }
      if (message.type !== "response.done") return;

      status = message.response?.status ?? null;
      statusDetails = message.response?.status_details ?? null;
      usage = message.response?.usage ?? null;
      if (status && status !== "completed" && status !== "incomplete") {
        const reason = statusDetails?.reason ?? statusDetails?.error?.code ?? "unknown";
        finish(new Error(`${turn.id}: response ended with status ${status} (${reason}).`));
        return;
      }
      finish();
    };
    const onError = () => finish(new Error(`${turn.id}: realtime socket error.`));
    const onClose = () => finish(new Error(`${turn.id}: socket closed before response.done.`));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    try {
      send(socket, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: turn.text }],
        },
      });
      send(socket, { type: "response.create" });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function runPhase(
  name: "baseline" | "revised" | "current",
  instructions: string,
  turns: ConversationTurn[],
  totalAudioBeforeSeconds: number,
): Promise<PhaseResult> {
  const config = buildRealtimeSessionConfig({
    model,
    voice,
    transcriptionModel,
    instructions,
  });
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  let socket: WebSocket | undefined;
  const results: TurnResult[] = [];
  let phaseAudioSeconds = 0;
  let sessionEcho: SessionEcho | null = null;

  try {
    socket = new RealtimeWebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Realtime connection timed out.")), requestTimeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.removeEventListener("open", onOpen);
        socket?.removeEventListener("error", onError);
        socket?.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("Could not connect to the Realtime API."));
      const onClose = () => finish(new Error("Realtime socket closed before setup."));
      socket?.addEventListener("open", onOpen);
      socket?.addEventListener("error", onError);
      socket?.addEventListener("close", onClose);
    });

    // This is the exact shared production session shape. The baseline phase
    // changes only the frozen persona text for a controlled comparison.
    send(socket, { type: "session.update", session: config });
    sessionEcho = await waitForSession(socket, instructions);
    process.stdout.write(
      `${name} session instructions exact: ${sessionEcho.exact} `
      + `(sent sha256:${sessionEcho.sentHash}, echoed sha256:${sessionEcho.echoedHash ?? "unavailable"})\n`,
    );
    if (!sessionEcho.exact) {
      process.stderr.write(`${name}: provider session instructions did not echo the configured persona; no turns sent.\n`);
      return {
        name,
        turns: results,
        totalAudioSeconds: 0,
        sessionEcho,
      };
    }

    for (const turn of turns) {
      const result = await requestTurn(socket, turn, phaseAudioSeconds, totalAudioBeforeSeconds);
      results.push(result);
      phaseAudioSeconds += result.audioSeconds;
      process.stdout.write(
        `${name}/${turn.id}: ${result.audioSeconds.toFixed(2)}s audio, `
        + `${result.responseElapsedMs.toFixed(0)}ms response, `
        + `${result.transcriptDeltaCount} transcript deltas\n`,
      );
      // Print generated transcript only, never a prompt, credential, or
      // expected canned answer. JSON quoting makes line breaks unambiguous.
      process.stdout.write(`  generated transcript: ${JSON.stringify(result.transcript)}\n`);
      if (result.safetyCutoff) {
        process.stdout.write(
          `  safety cutoff: stopped after ${maxTurnSeconds}s or the remaining ${maxTotalSeconds}s budget.\n`,
        );
        break;
      }
    }
  } finally {
    closeSocket(socket);
  }

  if (!sessionEcho) throw new Error(`${name}: session echo was not received.`);
  return {
    name,
    turns: results,
    totalAudioSeconds: Number(phaseAudioSeconds.toFixed(3)),
    sessionEcho,
  };
}

function printSummary(phases: PhaseResult[], errors: string[]) {
  const totalAudioSeconds = phases.reduce((total, phase) => total + phase.totalAudioSeconds, 0);
  const summary = {
    kind: "realtime-conversation-quality-audit",
    generatedAt: new Date().toISOString(),
    provider: {
      model,
      voice,
      transcriptionModel,
      audioSampleRate: sampleRate,
      reasoning: "low",
      maxOutputTokens: 512,
    },
    safetyLimits: {
      requestTimeoutMs,
      maxTurnSeconds,
      maxTotalSeconds,
    },
    totalAudioSeconds: Number(totalAudioSeconds.toFixed(3)),
    mode: shortCurrent ? "short-current" : "baseline-vs-revised",
    phases,
    errors,
    note: "These are provider-stream observations, not an automatic human-likeness score or a browser/microphone test.",
  };
  process.stdout.write("\nAUDIT SUMMARY\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing from .env.local.");

  const phases: PhaseResult[] = [];
  const errors: string[] = [];
  let totalAudioSeconds = 0;
  const studies: ReadonlyArray<readonly [
    "baseline" | "revised" | "current",
    string,
    ConversationTurn[],
  ]> = [
    ...(shortCurrent
      ? [["current", VOICE_PERSONA_INSTRUCTIONS, shortCurrentTurns] as const]
      : [
          ["baseline", BASELINE_VOICE_PERSONA_INSTRUCTIONS, baselineTurns] as const,
          ["revised", VOICE_PERSONA_INSTRUCTIONS, revisedTurns] as const,
        ]),
  ];

  for (const [name, instructions, turns] of studies) {
    try {
      const result = await runPhase(name, instructions, turns, totalAudioSeconds);
      phases.push(result);
      totalAudioSeconds += result.totalAudioSeconds;
      if (!result.sessionEcho.exact) {
        errors.push(`${name}: session instructions echo mismatch.`);
      }
    } catch (error) {
      const message = `${name}: ${safeError(error)}`;
      errors.push(message);
      process.stderr.write(`${message}\n`);
    }
  }

  printSummary(phases, errors);
  if (errors.length > 0 || phases.every((phase) => phase.turns.length === 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
