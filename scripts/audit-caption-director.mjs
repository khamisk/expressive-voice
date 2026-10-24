import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEECH_PLAN_ANALYZER_INSTRUCTIONS,
  SPEECH_PLAN_TOOL,
  REACTION_ANALYZER_INSTRUCTIONS,
  REACTION_TOOL,
  buildReactionAnalysisInput,
  buildSpeechPlanInput,
  parseCaptionBreaks,
  parseReactionPlan,
  parseReactionCue,
  parseStreamingReactionPlan,
} from "../src/lib/reaction-cues.ts";
import { captionWords } from "../src/lib/spoken-caption.ts";

// Explicit live-provider diagnostic. Bounded synthetic text-only requests, no
// microphone, audio generation, or artifact writes. Uses the app's exact
// director prompt, parser, and 800-token response cap.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true, override: true });
const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const effects = process.argv.includes("--effects");
const reactions = effects || process.argv.includes("--reactions");
const cases = effects ? [
  { id: "warm-thanks", user: "That actually helped a lot. Thanks for sticking with me.", text: "", expectedEffects: ["heart", "none"] },
  { id: "puzzled-sign", user: "Wait, the sign says turn left but the arrow points right. How is that supposed to work?", text: "", expectedEffects: ["question", "none"] },
  { id: "realization", user: "Oh! I finally figured out why it kept crashing. I was using the old token. Now it all makes sense.", text: "", expectedEffects: ["idea", "sparkle", "confetti"] },
  { id: "vulnerable-news", user: "My friend really let me down and I feel awful about it.", text: "", expectedEffects: ["none"] },
  { id: "ordinary-coffee", user: "I'm getting coffee before work.", text: "", expectedEffects: ["none"] },
] : reactions ? [
  { id: "earned-win", user: "I finally got the job I really wanted!", text: "" },
  { id: "reversed-win", user: "Actually, I misread the email. I didn't get the job. It was a rejection.", text: "", context: [
    { role: "user", text: "I got the job!" },
    { role: "assistant", text: "That's wonderful news!" },
    { role: "user", text: "Actually, I misread the email. I didn't get the job. It was a rejection." },
  ] },
] : [
  { id: "side-question", text: "What's going on on your side?", user: "Hey, how are you?" },
  { id: "empathy-question", text: "I'm so sorry to hear that happened.\nThat really sucks.\nHow do you feel about it?", user: "I didn't get the job I wanted." },
  { id: "correction", text: "I was wrong about that.\nThanks for catching it.\nThat sounds frustrating, but we can fix it together.", user: "That isn't what I meant. This is frustrating." },
];

function audit(sample) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    let socket;
    let requestedAt = 0;
    let firstDeltaMs = null;
    let captionReadyMs = null;
    let firstCueMs = null;
    const context = sample.context ?? [{ role: "user", text: sample.user }];
    const tool = reactions ? REACTION_TOOL : SPEECH_PLAN_TOOL;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error(`${sample.id}: bounded provider check timed out.`)), 20_000);
    try {
      socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      finish(new Error(`${sample.id}: could not create the provider connection.`));
      return;
    }
    const request = () => {
      requestedAt = performance.now();
      socket.send(JSON.stringify({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          max_output_tokens: reactions ? 224 : 800,
          instructions: reactions ? REACTION_ANALYZER_INSTRUCTIONS : SPEECH_PLAN_ANALYZER_INSTRUCTIONS,
          tools: [tool],
          tool_choice: { type: "function", name: tool.name },
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: reactions ? buildReactionAnalysisInput(sample.id, context) : buildSpeechPlanInput(sample.id, context, sample.text) }],
          }],
        },
      }));
    };
    socket.addEventListener("open", () => {
      // The live application sets low reasoning on its session. A fresh
      // provider socket otherwise uses a different reasoning/latency profile.
      socket.send(JSON.stringify({ type: "session.update", session: {
        type: "realtime",
        output_modalities: ["text"],
        reasoning: { effort: "low" },
        audio: { input: { turn_detection: null } },
      } }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); }
      catch { finish(new Error(`${sample.id}: malformed provider event.`)); return; }
      if (message.type === "session.updated" && !requestedAt) { request(); return; }
      if (message.type === "error") {
        finish(new Error(`${sample.id}: provider rejected the request (${message.error?.code ?? "unknown"}).`));
        return;
      }
      if (message.type === "response.output_text.delta" || message.type === "response.function_call_arguments.delta") {
        firstDeltaMs ??= Math.round(performance.now() - requestedAt);
        text += message.delta ?? "";
        if (reactions && firstCueMs === null && parseReactionCue(text, {
          id: sample.id, turnId: sample.id, source: "user", currentUserText: sample.user,
        })) firstCueMs = Math.round(performance.now() - requestedAt);
        if (!reactions && captionReadyMs === null && parseCaptionBreaks(text, sample.text) !== null) {
          captionReadyMs = Math.round(performance.now() - requestedAt);
        }
        if (!reactions && firstCueMs === null && parseStreamingReactionPlan(text, {
          idPrefix: sample.id, turnId: sample.id, currentAssistantText: sample.text,
        })?.length) firstCueMs = Math.round(performance.now() - requestedAt);
      }
      if (message.type !== "response.done") return;
      if (message.response?.status !== "completed") {
        finish(new Error(`${sample.id}: incomplete director response (${message.response?.status ?? "unknown"}).`));
        return;
      }
      if (reactions) {
        const cue = parseReactionCue(text, { id: sample.id, turnId: sample.id, source: "user", currentUserText: sample.user });
        if (!cue?.intent || (sample.id === "earned-win" && !["proud", "excited", "delighted", "joyful"].includes(cue.expression))
          || (sample.expectedEffects && !sample.expectedEffects.includes(cue.effect))
          || (sample.id === "reversed-win" && (cue.effect !== "none" || !["sad", "concerned"].includes(cue.expression)))) {
          console.error(JSON.stringify({ sample: sample.id, cue, firstCueMs }));
          finish(new Error(`${sample.id}: the private reaction did not match the clear test scenario.`));
          return;
        }
        finish(null, { sample: sample.id, cue, firstDeltaMs, firstCueMs, completedMs: Math.round(performance.now() - requestedAt), usage: message.response.usage });
        return;
      }
      const breaks = parseCaptionBreaks(text, sample.text);
      const cues = parseReactionPlan(text, { idPrefix: sample.id, turnId: sample.id, currentAssistantText: sample.text });
      if (!breaks || !cues?.length || cues.some((cue) => !cue.intent)) {
        // Only the synthetic provider answer, never the request/credentials.
        console.error(JSON.stringify({ sample: sample.id, breaks, firstDeltaMs, captionReadyMs, completedMs: Math.round(performance.now() - requestedAt), output: key ? text.split(key).join("[redacted]") : text }));
        finish(new Error(`${sample.id}: director output failed the app's caption/acting validation.`));
        return;
      }
      if (sample.id === "side-question" && (breaks.length !== 1 || breaks[0] !== 0)) {
        finish(new Error("side-question: the provider split the short question."));
        return;
      }
      const words = captionWords(sample.text);
      finish(null, {
        sample: sample.id,
        captions: breaks.map((start, index) => words.slice(start, breaks[index + 1]).join(" ")),
        acceptedBreaks: breaks,
        captionReadyMs,
        firstCueMs,
        firstDeltaMs,
        completedMs: Math.round(performance.now() - requestedAt),
        cues: cues.map(({ anchor, expression, intent, gesture, accent }) => ({ anchor, expression, intent, gesture, accent })),
        usage: message.response.usage,
      });
    });
    socket.addEventListener("error", () => finish(new Error(`${sample.id}: provider socket failed.`)));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error(`${sample.id}: provider closed before completing.`));
    });
  });
}

try {
  if (!key) throw new Error("OPENAI_API_KEY is missing from .env.local.");
  console.log(`Live ${reactions ? "reaction" : "caption"}-director validation: ${model}; ${cases.length} text-only cases; maximum ${reactions ? 224 : 800} output tokens each.`);
  for (const sample of cases) console.log(JSON.stringify(await audit(sample), null, 2));
  console.log(effects
    ? "PASS: five contextual effect checks completed; inspect the reported choices. No audio, microphone, or visual assessment was performed."
    : reactions
    ? "PASS: the win and its reversal produced appropriate grounded reactions, with no celebration for rejection. No audio or microphone session was created."
    : "PASS: all three responses preserved exact words, valid thought breaks, and anchored acting cues. No audio or microphone session was created.");
} catch (error) {
  const message = error instanceof Error ? error.message : "Caption audit failed.";
  console.error(key ? message.split(key).join("[redacted]") : message);
  process.exitCode = 1;
}
