import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient, type ReactionDiagnostic } from "./realtime";
import type { ReactionCue } from "./reaction-cues";

type WireEvent = Record<string, unknown>;

type InternalEarlyClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  handleMessage: (raw: string) => void;
  sendTextTurn: (text: string) => void;
  outputLevel: number;
  outputWasAudible: boolean;
  outputFirstAudibleAt: number | null;
  outputMeterActive: boolean;
  outputPlaybackEnded: boolean;
  responseActive: boolean;
  activeVoiceResponseId: string | null;
  transcriptCanPlay: boolean;
  responseInterrupted: boolean;
};

describe("Realtime fast speech cues", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient() {
    const sent: WireEvent[] = [];
    const cues: ReactionCue[] = [];
    const diagnostics: ReactionDiagnostic[] = [];
    const errors: string[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: () => undefined,
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onReactionCue: (cue) => cues.push(cue),
      onReactionDiagnostic: (event) => diagnostics.push(event),
      onError: (message) => errors.push(message),
    });
    const client = voice as unknown as InternalEarlyClient;
    client.channel = {
      readyState: "open",
      send: (raw) => sent.push(JSON.parse(raw) as WireEvent),
      close: () => undefined,
    };
    return { client, sent, cues, diagnostics, errors };
  }

  function advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(16, remaining);
      clock += step;
      vi.setSystemTime(clock);
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }

  function speechCues(cues: ReactionCue[]): ReactionCue[] {
    return cues.filter((cue) => cue.kind === "speech");
  }

  function speechPlanRequests(sent: WireEvent[]): WireEvent[] {
    return sent.filter((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return event.type === "response.create" && metadata?.kind === "speech_plan";
    });
  }

  function startVoiceResponse(client: InternalEarlyClient, id: string, audible: boolean): void {
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id } }));
    client.outputLevel = audible ? 0.12 : 0;
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: id }));
  }

  function assistantTranscript(client: InternalEarlyClient, id: string, delta: string): void {
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: id,
      delta,
    }));
  }

  function completeSpeechPlan(
    client: InternalEarlyClient,
    request: WireEvent,
    id = "late-speech-plan",
  ): void {
    const response = request.response as Record<string, unknown>;
    const metadata = response.metadata as Record<string, string>;
    const plan = {
      captions: ["That really hurts."],
      cues: [{
        kind: "speech",
        phraseIndex: 0,
        expression: "concerned",
        intent: "comfort",
        intensity: 0.9,
        effect: "none",
        confidence: 0.95,
        gesture: "lean-in",
        accent: "soften",
        anchor: "That really hurts",
      }],
    };
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id, metadata } }));
    client.handleMessage(JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: id,
      arguments: JSON.stringify(plan),
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  function completeSpeechPlanFor(
    client: InternalEarlyClient,
    request: WireEvent,
    phrase: string,
    cue: {
      expression: string;
      intent: string;
      intensity: number;
      confidence: number;
      gesture: string;
      accent: string;
      anchor?: string;
    },
    id = "authored-speech-plan",
  ): void {
    const response = request.response as Record<string, unknown>;
    const metadata = response.metadata as Record<string, string>;
    const plan = {
      captions: [phrase],
      cues: [{
        kind: "speech",
        phraseIndex: 0,
        expression: cue.expression,
        intent: cue.intent,
        intensity: cue.intensity,
        effect: "none",
        confidence: cue.confidence,
        gesture: cue.gesture,
        accent: cue.accent,
        anchor: cue.anchor ?? phrase,
      }],
    };
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id, metadata } }));
    client.handleMessage(JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: id,
      arguments: JSON.stringify(plan),
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  it("emits the concerned first phrase on first audible playback without waiting for an OOB result", () => {
    const { client, sent, cues, diagnostics } = createClient();

    client.sendTextTurn("I lost the job I really wanted.");
    startVoiceResponse(client, "voice-loss", true);
    assistantTranscript(client, "voice-loss", "That really hurts.");
    advance(16);

    const spoken = speechCues(cues);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({
      source: "assistant",
      expression: "concerned",
      intent: "comfort",
      effect: "none",
      anchor: "That really hurts.",
    });
    expect(client.outputFirstAudibleAt).not.toBeNull();
    expect(spoken[0].turnId).toBeDefined();
    expect(speechPlanRequests(sent)).toHaveLength(1);
    // No speech-plan response is fed into the client in this fixture. The
    // fast cue must therefore be the first assistant cue, rather than a
    // delayed result from the private OOB director.
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "requested" }));
  });

  it("does not act a generated first phrase while output remains silent", () => {
    const { client, cues } = createClient();

    client.sendTextTurn("I lost the job I really wanted.");
    startVoiceResponse(client, "voice-silent", false);
    assistantTranscript(client, "voice-silent", "That really hurts.");
    advance(1_000);

    expect(speechCues(cues)).toEqual([]);
    expect(client.outputFirstAudibleAt).toBeNull();
  });

  it("does not replay a fast first beat when a late OOB plan arrives for the same anchor", () => {
    const { client, sent, cues } = createClient();

    client.sendTextTurn("I lost the job I really wanted.");
    startVoiceResponse(client, "voice-late-plan", true);
    assistantTranscript(client, "voice-late-plan", "That really hurts.");
    advance(16);
    expect(speechCues(cues)).toHaveLength(1);

    const [planRequest] = speechPlanRequests(sent);
    expect(planRequest).toBeDefined();
    completeSpeechPlan(client, planRequest);

    expect(speechCues(cues)).toHaveLength(1);
    expect(speechCues(cues)[0]).toMatchObject({ anchor: "That really hurts." });
  });

  it("resets the fast-cue cache when a new voice response begins", () => {
    const { client, cues } = createClient();

    client.sendTextTurn("I lost the job I really wanted.");
    startVoiceResponse(client, "voice-first", true);
    assistantTranscript(client, "voice-first", "That really hurts.");
    advance(16);
    expect(speechCues(cues)).toHaveLength(1);

    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-first", status: "completed" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-first" }));
    client.sendTextTurn("I lost my apartment too.");
    startVoiceResponse(client, "voice-second", true);
    assistantTranscript(client, "voice-second", "That really hurts.");
    advance(16);

    const spoken = speechCues(cues);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toMatchObject({
      source: "assistant",
      expression: "concerned",
      anchor: "That really hurts.",
    });
    expect(spoken[1].turnId).not.toBe(spoken[0].turnId);
  });

  it("emits one immediate user cue for an explicit first-person win before OOB analysis", () => {
    const { client, cues, diagnostics } = createClient();

    client.sendTextTurn("I finally got the job I really wanted!");

    const userCues = cues.filter((cue) => cue.source === "user");
    expect(userCues).toHaveLength(1);
    expect(userCues[0]).toMatchObject({
      expression: "delighted",
      intent: "celebrate",
      effect: "confetti",
      source: "user",
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      state: "prepared",
      reason: "explicit_user_event",
    }));
  });

  it("upgrades one neutral fast beat to a confident authored meaning while that phrase is audible", () => {
    const { client, sent, cues } = createClient();
    const phrase = "Sure, I can explain that.";

    client.sendTextTurn("What do you think?");
    startVoiceResponse(client, "voice-neutral-upgrade", true);
    assistantTranscript(client, "voice-neutral-upgrade", phrase);
    advance(16);

    expect(speechCues(cues)).toHaveLength(1);
    expect(speechCues(cues)[0]).toMatchObject({
      expression: "neutral",
      intent: "explain",
      effect: "none",
      anchor: phrase,
    });

    const [planRequest] = speechPlanRequests(sent);
    expect(planRequest).toBeDefined();
    completeSpeechPlanFor(client, planRequest, phrase, {
      expression: "curious",
      intent: "question",
      intensity: 0.9,
      confidence: 0.95,
      gesture: "lean-in",
      accent: "widen",
    });

    const spoken = speechCues(cues);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toMatchObject({
      expression: "curious",
      intent: "question",
      effect: "none",
      confidence: 0.95,
      anchor: phrase,
    });
  });

  it("does not upgrade a neutral phrase after a later fast beat has become current", () => {
    const { client, sent, cues } = createClient();
    const firstPhrase = "Sure, I can explain that.";
    const assistantText = `${firstPhrase} That sounds really rough.`;

    client.sendTextTurn("What do you think?");
    startVoiceResponse(client, "voice-past-upgrade", true);
    assistantTranscript(client, "voice-past-upgrade", assistantText);
    advance(1_600);

    const beforeLatePlan = speechCues(cues);
    expect(beforeLatePlan.length).toBeGreaterThanOrEqual(2);
    expect(beforeLatePlan[0]).toMatchObject({ expression: "neutral", anchor: firstPhrase });
    expect(beforeLatePlan.some((cue) => cue.expression === "concerned")).toBe(true);

    const [planRequest] = speechPlanRequests(sent);
    expect(planRequest).toBeDefined();
    completeSpeechPlanFor(client, planRequest, firstPhrase, {
      expression: "curious",
      intent: "question",
      intensity: 0.9,
      confidence: 0.95,
      gesture: "lean-in",
      accent: "widen",
    });

    // The first phrase is past and a later beat has already acted. A delayed
    // director result must not rewind the character or add a third cue.
    expect(speechCues(cues)).toHaveLength(beforeLatePlan.length);
  });

  it("ignores a duplicate authored upgrade and never replays its speech effect", () => {
    const { client, sent, cues } = createClient();
    const phrase = "Sure, I can explain that.";

    client.sendTextTurn("What do you think?");
    startVoiceResponse(client, "voice-duplicate-upgrade", true);
    assistantTranscript(client, "voice-duplicate-upgrade", phrase);
    advance(16);
    const [planRequest] = speechPlanRequests(sent);
    expect(planRequest).toBeDefined();

    const authored = {
      expression: "curious",
      intent: "question",
      intensity: 0.9,
      confidence: 0.95,
      gesture: "lean-in",
      accent: "widen",
    };
    completeSpeechPlanFor(client, planRequest, phrase, authored, "authored-upgrade-1");
    expect(speechCues(cues)).toHaveLength(2);
    expect(speechCues(cues)[1]).toMatchObject({ expression: "curious", effect: "none" });

    completeSpeechPlanFor(client, planRequest, phrase, authored, "authored-upgrade-duplicate");
    expect(speechCues(cues)).toHaveLength(2);
    expect(speechCues(cues).filter((cue) => cue.expression === "curious")).toHaveLength(1);
    expect(speechCues(cues).every((cue) => cue.effect === "none")).toBe(true);
  });
});
