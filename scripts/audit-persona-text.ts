import dotenv from "dotenv";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_TRANSCRIPTION_MODEL,
  VOICE_PERSONA_INSTRUCTIONS,
  buildRealtimeSessionConfig,
} from "../server/voice-persona.ts";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({
  path: path.join(projectDirectory, ".env.local"),
  override: true,
  quiet: true,
});

// Linguistic/style check only. It uses the exact production session config,
// then asks each response for text so it cannot consume another audio budget.
// This is not a voice-cadence, browser, microphone, or speaker test.
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;
const voice = process.env.OPENAI_REALTIME_VOICE ?? DEFAULT_REALTIME_VOICE;
const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL;
const maxOutputTokens = 128;
const requestTimeoutMs = 20_000;
const RealtimeWebSocket = WebSocket as unknown as {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
};

const turns = [
  {
    id: "factual",
    category: "casual why/how",
    text: "I'm making breakfast. Why does toast smell so good when it browns?",
  },
  {
    id: "correction",
    category: "correction",
    text: "Actually, I got that wrong earlier. The appointment is next Thursday, not tomorrow.",
  },
  {
    id: "joke",
    category: "small joke",
    text: "I told my code it needed a break, and it opened an issue.",
  },
  {
    id: "bad-news",
    category: "bad news",
    text: "On a more serious note, I got a rejection email after the final interview. I thought it went well.",
  },
  {
    id: "new-topic",
    category: "new-topic redirect",
    text: "Different topic: what's a quick dinner I can make with eggs and rice?",
  },
  {
    id: "explicit-detail",
    category: "explicit detail request",
    text: "Actually, explain the browning chemistry in detail, step by step, and include the main reactions.",
  },
] as const;

// A final, smaller confirmation after a wording change. Keep the default
// four-turn study reproducible, and never generate audio in either mode.
const selectedTurns = process.argv.includes("--follow-up")
  ? turns.filter((turn) => turn.id === "correction" || turn.id === "bad-news")
  : turns;

function send(socket: WebSocket, event: Record<string, unknown>) {
  socket.send(JSON.stringify(event));
}

function parseMessage(event: MessageEvent): Record<string, any> {
  try {
    const value = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (!value || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, any>;
  } catch {
    throw new Error("Realtime returned a malformed event.");
  }
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
    // The bounded audit result is already determined.
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
        finish(new Error(`Realtime session setup failed (${message.error?.code ?? "unknown"}).`));
      } else if (message.type === "session.updated") {
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
    const onError = () => finish(new Error("Realtime socket failed during setup."));
    const onClose = () => finish(new Error("Realtime socket closed during setup."));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

type TurnResult = {
  id: string;
  category: string;
  text: string;
  response: string;
  words: number;
  questions: number;
  sentences: number;
  cannedReassurance: string[];
  offerMarkers: string[];
  emDashCount: number;
  correctionGrounded: boolean | null;
  newTopicGrounded: boolean | null;
  elapsedMs: number;
  firstDeltaMs: number | null;
  status: string | null;
  usage: unknown;
};

function describeText(text: string, turnId: string): Omit<TurnResult, "id" | "category" | "text" | "elapsedMs" | "firstDeltaMs" | "status" | "usage"> {
  const words = text.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?/g)?.length ?? 0;
  const questions = (text.match(/\?/g) ?? []).length;
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.length ?? (text.trim() ? 1 : 0);
  const reassurancePatterns = [
    ["no worries", /\bno worries\b/iu],
    ["that sounds", /\bthat sounds\b/iu],
    ["happens all the time", /\bhappens all the time\b/iu],
    ["sorry to hear", /\bsorry to hear\b/iu],
    ["you've got this", /\byou['’]ve got this\b/iu],
    ["everything will be okay", /\beverything (?:will|is going to) be okay\b/iu],
  ] as const;
  const cannedReassurance = reassurancePatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  const offerPatterns = [
    ["if you want/like", /\bif you (?:want|like)\b/iu],
    ["i can help", /\bi can help\b/iu],
    ["want me to", /\bwant me to\b/iu],
    ["we can", /\bwe can\b/iu],
    ["let me know", /\blet me know\b/iu],
  ] as const;
  const offerMarkers = offerPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  const correctionGrounded = turnId === "correction"
    ? /\bnext thursday\b/iu.test(text) && !/\b(?:appointment|it)\s+(?:is|was)\s+tomorrow\b/iu.test(text)
    : null;
  const newTopicGrounded = turnId === "new-topic"
    ? /\b(?:dinner|eggs?|rice)\b/iu.test(text)
    : null;
  return {
    response: text.trim(),
    words,
    questions,
    sentences,
    cannedReassurance,
    offerMarkers,
    emDashCount: (text.match(/—|–/g) ?? []).length,
    correctionGrounded,
    newTopicGrounded,
  };
}

function requestTurn(socket: WebSocket, turn: (typeof turns)[number]): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    let responseId: string | null = null;
    let status: string | null = null;
    let usage: unknown = null;
    let firstDeltaMs: number | null = null;
    const requestedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - requestedAt);
    const timer = setTimeout(() => finish(new Error(`${turn.id}: response timed out.`)), requestTimeoutMs);
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
      const description = describeText(response, turn.id);
      resolve({
        id: turn.id,
        category: turn.category,
        text: turn.text,
        ...description,
        elapsedMs: elapsedMs(),
        firstDeltaMs,
        status,
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
        finish(new Error(`${turn.id}: provider returned ${message.error?.code ?? "unknown"}.`));
        return;
      }
      if (message.type === "response.created") {
        responseId = message.response?.id ?? null;
        return;
      }
      if (message.type === "response.output_text.delta") {
        if (typeof message.delta !== "string") return;
        firstDeltaMs ??= elapsedMs();
        response += message.delta;
        return;
      }
      if (message.type !== "response.done") return;
      status = message.response?.status ?? null;
      usage = message.response?.usage ?? null;
      if (status && status !== "completed" && status !== "incomplete") {
        finish(new Error(`${turn.id}: response ended with status ${status}.`));
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
      send(socket, {
        type: "response.create",
        response: {
          output_modalities: ["text"],
          max_output_tokens: maxOutputTokens,
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function main() {
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing from .env.local.");
  const config = buildRealtimeSessionConfig({
    model,
    voice,
    transcriptionModel,
    instructions: VOICE_PERSONA_INSTRUCTIONS,
  });
  const socket = new RealtimeWebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const results: TurnResult[] = [];
  let sessionEcho: SessionEcho | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime connection timed out.")), requestTimeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the Realtime API."));
      };
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error("Realtime socket closed before setup."));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
    send(socket, { type: "session.update", session: config });
    sessionEcho = await waitForSession(socket, VOICE_PERSONA_INSTRUCTIONS);
    process.stdout.write(
      `session instructions exact: ${sessionEcho.exact} `
      + `(sent sha256:${sessionEcho.sentHash}, echoed sha256:${sessionEcho.echoedHash ?? "unavailable"})\n`,
    );
    if (!sessionEcho.exact) {
      process.stderr.write("Provider session echo did not match the configured persona; no turns were sent.\n");
    } else {
      for (const turn of selectedTurns) {
        const result = await requestTurn(socket, turn);
        results.push(result);
      process.stdout.write(`${turn.id}: ${result.elapsedMs}ms, ${result.words} words, ${result.questions} questions, `
        + `offers=${result.offerMarkers.length}, emDash=${result.emDashCount}\n`);
        process.stdout.write(`  generated: ${JSON.stringify(result.response)}\n`);
      }
    }
  } finally {
    closeSocket(socket);
  }

  const summary = {
    kind: "realtime-persona-text-audit",
    generatedAt: new Date().toISOString(),
    provider: { model, voice, transcriptionModel, reasoning: "low", maxOutputTokens },
    sessionEcho,
    turns: results.map(({ id, category, response, words, questions, sentences, cannedReassurance, offerMarkers, emDashCount, correctionGrounded, newTopicGrounded, elapsedMs, firstDeltaMs, status, usage }) => ({
      id,
      category,
      response,
      words,
      questions,
      sentences,
      cannedReassurance,
      offerMarkers,
      emDashCount,
      correctionGrounded,
      newTopicGrounded,
      elapsedMs,
      firstDeltaMs,
      status,
      usage,
    })),
    note: "Descriptive linguistic evidence only. This is not an automatic human-likeness score or voice/browser/microphone proof.",
  };
  process.stdout.write(`\nTEXT AUDIT SUMMARY\n${JSON.stringify(summary, null, 2)}\n`);
  if (!sessionEcho?.exact || results.length !== selectedTurns.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
