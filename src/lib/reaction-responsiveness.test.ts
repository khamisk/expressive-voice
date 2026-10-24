import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient, type ReactionDiagnostic } from "./realtime";
import type { ReactionCue } from "./reaction-cues";

type SentEvent = Record<string, unknown>;

type InternalClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  handleMessage: (raw: string) => void;
  sendTextTurn: (text: string) => void;
  close: (resetPhase?: boolean) => void;
  checkTalkOver: (outputBoundary?: "word" | "phrase" | "sentence") => void;
  outputMeterActive: boolean;
  outputWasAudible: boolean;
  outputQuietSince: number | null;
  responseActive: boolean;
  outputLevel: number;
  outputPlaybackEnded: boolean;
  presentedAssistantTranscript: string;
  emitAvailableSpeechCues: () => void;
};

type ReactionEnvelope = {
  event_id: string;
  response: { metadata: Record<string, string> };
};

type ReactionResult = {
  expression: string;
  intensity: number;
  effect: string;
  confidence: number;
  anchor: string;
};

describe("reaction responsiveness", () => {
  let clock = 0;
  const clients: InternalClient[] = [];

  function advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(16, remaining);
      clock += step;
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    for (const client of clients) client.close(false);
    clients.length = 0;
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient() {
    const sent: SentEvent[] = [];
    const phases: string[] = [];
    const cues: ReactionCue[] = [];
    const diagnostics: ReactionDiagnostic[] = [];
    const errors: string[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onReactionCue: (cue) => cues.push(cue),
      onReactionDiagnostic: (event) => diagnostics.push(event),
      onError: (message) => errors.push(message),
    });
    const client = voice as unknown as InternalClient;
    client.channel = {
      readyState: "open",
      send: (raw: string) => sent.push(JSON.parse(raw) as SentEvent),
      close: () => undefined,
    };
    clients.push(client);
    return { client, sent, phases, cues, diagnostics, errors };
  }

  function reactionRequests(sent: SentEvent[]): SentEvent[] {
    return sent.filter((event) => {
      const response = event.response as { metadata?: Record<string, unknown> } | undefined;
      return event.type === "response.create" && response?.metadata?.kind === "reaction_cue";
    });
  }

  function voiceResponseCreates(sent: SentEvent[]): SentEvent[] {
    return sent.filter((event) => event.type === "response.create" && event.response === undefined);
  }

  function reactionRequest(sent: SentEvent[]): ReactionEnvelope {
    const event = reactionRequests(sent)[0];
    if (!event) throw new Error("Expected a reaction response.create request");
    return event as unknown as ReactionEnvelope;
  }

  function markVoiceResponseCreated(client: InternalClient, id = "voice-1"): void {
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id } }));
  }

  function completeReaction(
    client: InternalClient,
    request: ReactionEnvelope,
    id = "reaction-1",
    result: ReactionResult = {
      expression: "proud",
      intensity: 0.9,
      effect: "confetti",
      confidence: 0.95,
      anchor: "got the job",
    },
    includeDelta = true,
  ): void {
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata: request.response.metadata },
    }));
    const argumentsText = JSON.stringify(result);
    if (includeDelta) {
      client.handleMessage(JSON.stringify({
        type: "response.function_call_arguments.delta",
        response_id: id,
        delta: argumentsText,
      }));
    }
    client.handleMessage(JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: id,
      arguments: argumentsText,
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  function completeSpeechPlan(
    client: InternalClient,
    request: SentEvent,
    id: string,
    result: { cues: Array<Record<string, unknown>> },
  ): void {
    const response = request.response as { metadata: Record<string, string> };
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata: response.metadata },
    }));
    const text = JSON.stringify(result);
    client.handleMessage(JSON.stringify({ type: "response.function_call_arguments.delta", response_id: id, delta: text }));
    client.handleMessage(JSON.stringify({ type: "response.function_call_arguments.done", response_id: id, arguments: text }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  it("starts voice immediately while a finalized user cue is still being prepared", () => {
    const { client, sent, cues, diagnostics } = createClient();

    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);

    // The private interpretation request must not be a prerequisite for the
    // audible response. This is the latency property that makes the exchange
    // feel conversational instead of waiting on a second model turn.
    expect(voiceResponseCreates(sent)).toHaveLength(1);
    expect(cues).toEqual([]);

    completeReaction(client, request);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      source: "user",
      expression: "proud",
      effect: "confetti",
      turnId: request.response.metadata.turn_id,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "prepared" }));
    expect(client.responseActive).toBe(true);
    expect(voiceResponseCreates(sent)).toHaveLength(1);
  });

  it("prepares an overlap reaction during old audio and releases it once at the new voice handoff", () => {
    const { client, sent, cues, diagnostics } = createClient();

    client.sendTextTurn("Tell me something.");
    markVoiceResponseCreated(client, "voice-old");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-old" }));

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "new-input" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "new-input",
      delta: "I've got the job I really wanted",
    }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "new-input",
      transcript: "I've got the job I really wanted!",
    }));

    const requests = reactionRequests(sent);
    expect(requests).toHaveLength(2);
    const overlapRequest = requests.at(-1) as unknown as ReactionEnvelope;
    completeReaction(client, overlapRequest, "reaction-overlap");

    // The interpretation is complete, but old assistant audio still owns the
    // character. It is held rather than appearing on top of the old reply.
    expect(cues).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "prepared" }));

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    advance(500);
    client.checkTalkOver("sentence");
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(0);
    advance(139);
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(0);
    advance(1);

    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toHaveLength(1);

    // The transport acknowledges the cancelled generation and then drains the
    // old buffer. GA includes the response id on the clear acknowledgement;
    // only that matching event is the release point for the cached cue.
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-old", status: "cancelled" },
    }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));

    expect(voiceResponseCreates(sent)).toHaveLength(2);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ source: "user", expression: "proud" });

    // A duplicate clear/done acknowledgment must not replay the same cue or
    // create a third voice response.
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "cancelled" } }));
    expect(voiceResponseCreates(sent)).toHaveLength(2);
    expect(cues).toHaveLength(1);
  });

  it("accepts a tool-call done event when its argument delta is missing", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);

    // GA Realtime tool calls can deliver the completed arguments without a
    // preceding delta. The done event must still prepare and emit the cue.
    completeReaction(client, request, "reaction-done-only", {
      expression: "proud",
      intensity: 0.9,
      effect: "confetti",
      confidence: 0.95,
      anchor: "got the job",
    }, false);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ source: "user", expression: "proud" });
  });

  it("invalidates a prepared reaction as soon as a newer user turn begins", () => {
    const { client, sent, cues, diagnostics } = createClient();

    client.sendTextTurn("I've got the job I really wanted!");
    const first = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));

    // There is no finalized correction yet, but this speech_started event is
    // enough to retire the previous turn's pending interpretation.
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "correction" }));
    completeReaction(client, first, "reaction-stale");

    expect(cues).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "rejected", reason: "stale_turn" }));
  });

  it("does not replay a delayed turn reaction after a quiet backchannel, while the old speech plan remains valid", () => {
    const { client, sent, cues, diagnostics } = createClient();
    const assistantText = "That is wonderful news.";

    client.sendTextTurn("I've got the job I really wanted!");
    const turnReaction = reactionRequest(sent);
    markVoiceResponseCreated(client, "voice-backchannel");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: assistantText,
    }));
    const speechPlan = sent.find((event) => {
      const response = event.response as { metadata?: Record<string, unknown> } | undefined;
      return event.type === "response.create" && response?.metadata?.kind === "speech_plan";
    });
    if (!speechPlan) throw new Error("Expected the original assistant speech plan");

    // A bare acknowledgement is not a new semantic turn, but it must still
    // fence off any delayed reaction for the already-consumed user turn.
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "ack-input" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "ack-input",
      transcript: "yeah",
    }));

    completeReaction(client, turnReaction, "reaction-after-backchannel");
    expect(cues).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "rejected", reason: "stale_turn" }));

    // The acknowledgement must not retire the old assistant's audible plan.
    // Its phrase cue is still valid while that response is playing.
    completeSpeechPlan(client, speechPlan, "speech-plan-after-backchannel", {
      cues: [{
        kind: "speech",
        phraseIndex: 0,
        expression: "delighted",
        intensity: 0.85,
        effect: "none",
        confidence: 0.9,
        gesture: "lift",
        accent: "spark",
        anchor: "That is wonderful",
      }],
    });
    client.presentedAssistantTranscript = "That is wonderful";
    client.emitAvailableSpeechCues();

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ kind: "speech", turnId: turnReaction.response.metadata.turn_id });
  });

  it("does not start a reaction from a partial transcript when auxiliary ASR fails, but still starts voice", () => {
    const { client, sent, cues } = createClient();

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "failed-input" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "failed-input",
      delta: "I got the...",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));

    // The committed audio can proceed independently of auxiliary transcript
    // analysis. In particular, the unsafe partial prefix must not be sent to
    // the reaction director as if it were the user's completed thought.
    expect(voiceResponseCreates(sent)).toHaveLength(1);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed-input",
      error: { message: "No transcription" },
    }));

    expect(reactionRequests(sent)).toEqual([]);
    expect(voiceResponseCreates(sent)).toHaveLength(1);
    expect(cues).toEqual([]);
  });

  it("never displays a prepared user reaction after the client is closed", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);
    client.close(false);

    completeReaction(client, request, "reaction-after-close");

    expect(cues).toEqual([]);
  });

  it("rejects a late reaction after the voice turn has ended", () => {
    const { client, sent, cues, diagnostics } = createClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));

    completeReaction(client, request, "reaction-after-audio");

    expect(cues).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "rejected", reason: "voice_ended" }));
  });

  it("keeps a late turn reaction from overwriting an already emitted assistant phrase cue", () => {
    const { client, sent, cues, diagnostics } = createClient();
    const assistantText = "That sounds really rough.";

    client.sendTextTurn("I had a hard day.");
    const userReaction = reactionRequest(sent);
    markVoiceResponseCreated(client, "voice-phrase");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: assistantText,
    }));

    const speechPlan = sent.find((event) => {
      const response = event.response as { metadata?: Record<string, unknown> } | undefined;
      return event.type === "response.create" && response?.metadata?.kind === "speech_plan";
    });
    if (!speechPlan) throw new Error("Expected the first assistant phrase plan");
    completeSpeechPlan(client, speechPlan, "speech-plan-1", {
      cues: [{
        kind: "speech",
        phraseIndex: 0,
        expression: "concerned",
        intensity: 0.8,
        effect: "none",
        confidence: 0.9,
        gesture: "tilt-left",
        accent: "soften",
        anchor: "That sounds really",
      }],
    });

    // Simulate the shared caption/audio clock having reached the phrase. This
    // is the same public playback hook the client uses on each audio tick.
    client.presentedAssistantTranscript = "That sounds really";
    client.emitAvailableSpeechCues();
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ kind: "speech", expression: "concerned" });

    completeReaction(client, userReaction, "reaction-late");

    expect(cues).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      state: "rejected",
      reason: "reaction_after_speech_plan",
    }));
  });
});
