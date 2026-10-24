import "dotenv/config";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeRealtimeStartupError } from "./realtime-startup-error.ts";
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_TRANSCRIPTION_MODEL,
  VOICE_PERSONA_INSTRUCTIONS,
  buildRealtimeSessionConfig,
} from "./voice-persona.ts";

dotenv.config({ path: ".env.local", override: true });

const app = express();
const port = Number(process.env.PORT ?? 8787);
const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;
const voice = process.env.OPENAI_REALTIME_VOICE ?? DEFAULT_REALTIME_VOICE;
const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL;
const apiKey = process.env.OPENAI_API_KEY;

const sessionConfig = JSON.stringify(
  buildRealtimeSessionConfig({
    model,
    voice,
    transcriptionModel,
    instructions: VOICE_PERSONA_INSTRUCTIONS,
  }),
);

app.disable("x-powered-by");
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));

app.get("/api/config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ready: Boolean(apiKey), model, voice, turnDetection: "client", characterControl: "voice" });
});

app.post("/api/realtime/session", async (req, res) => {
  if (!apiKey) {
    res.status(503).json({
      error: "Add OPENAI_API_KEY to .env.local, then restart the app.",
    });
    return;
  }

  if (typeof req.body !== "string" || !req.body.startsWith("v=0")) {
    res.status(400).json({ error: "A valid WebRTC SDP offer is required." });
    return;
  }

  const form = new FormData();
  form.set("sdp", req.body);
  form.set("session", sessionConfig);

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });
    const body = await response.text();

    if (!response.ok) {
      const failure = describeRealtimeStartupError(response.status, body);
      console.error(`OpenAI Realtime session failed (${response.status}; ${failure.code}).`);
      res.status(response.status).json(failure);
      return;
    }

    res.type("application/sdp").send(body);
  } catch {
    console.error("OpenAI Realtime connection failed before a response was received.");
    res.status(502).json({ error: "The voice service is unreachable. Please try again." });
  }
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(dirname, "../dist");
app.use(express.static(distPath));
app.use((_req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    next();
    return;
  }
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Mood Voice API listening on http://127.0.0.1:${port}`);
});
