import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient } from "./realtime";
import type { ReactionCue } from "./reaction-cues";
import type { CharacterDisplayState } from "./voice-character";

type SentEvent = Record<string, unknown>;

type InternalClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  handleMessage: (raw: string) => void;
  sendTextTurn: (text: string) => void;
  close: (resetPhase?: boolean) => void;
  checkTalkOver: (outputBoundary?: "word" | "phrase" | "sentence") => void;
  processLocalInput: (rms: number, now: number) => void;
  manualTurnDetection: boolean;
  inputHeldFloor: boolean;
  beginOutputClear: () => void;
  requestQueuedResponse: () => void;
  queuedUserTurn: boolean;
  pendingUserTurnId: string | null;
  nativeCharacterEnabled: boolean;
  activeVoiceResponseId: string | null;
  activeVoiceTurnId: string | null;
  responseActive: boolean;
  responseHasAudio: boolean;
  outputMeterActive: boolean;
  outputSilenceTimer: number | null;
  outputWasAudible: boolean;
  outputLevel: number;
  outputPlaybackEnded: boolean;
  transcriptCanPlay: boolean;
  voiceResponseEnded: boolean;
  userSpeechActive: boolean;
  presentedAssistantTranscript: string;
  generatedTranscript: string;
  assistantTranscriptComplete: boolean;
  fastSpeechCues: Map<number, { cue: ReactionCue; end: number; emitted: boolean }>;
  emitAvailableSpeechCues: () => void;
};

type CharacterPlan = {
  silent: boolean;
  beats: Array<{
    expression: string;
    intensity: number;
    anchor: string;
    intent: string;
    gesture: string;
    accent: string;
    effect: string;
  }>;
};

describe("Realtime native character tool lifecycle", () => {
  const clients: InternalClient[] = [];
  let clock = 0;

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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function display(): CharacterDisplayState {
    return {
      expression: "curious",
      phase: "listening",
      gesture: "lean-in",
      accent: "widen",
      intent: "question",
      effect: "none",
      headTiltDegrees: 14.6,
      observedAtMs: 0,
    };
  }

  function createClient() {
    const sent: SentEvent[] = [];
    const cues: ReactionCue[] = [];
    const phases: string[] = [];
    const transcripts: string[] = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const voice = new RealtimeVoiceClient({
      getCharacterState: display,
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: (delta) => transcripts.push(delta),
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onReactionCue: (cue) => cues.push(cue),
      onReactionDiagnostic: (event) => diagnostics.push(event as unknown as Record<string, unknown>),
      onError: (message) => errors.push(message),
    });
    const client = voice as unknown as InternalClient;
    client.channel = {
      readyState: "open",
      send: (raw) => sent.push(JSON.parse(raw) as SentEvent),
      close: () => undefined,
    };
    clients.push(client);
    // This is the same capability signal the real session sends after the
    // /api/config characterControl:"voice" path is applied.
    client.handleMessage(JSON.stringify({
      type: "session.updated",
      session: { tools: [{ type: "function", name: "perform_character" }] },
    }));
    return { client, sent, cues, phases, transcripts, diagnostics, errors };
  }

  function responseCreates(sent: SentEvent[]): SentEvent[] {
    return sent.filter((event) => event.type === "response.create");
  }

  function nativeInitialResponseCreates(sent: SentEvent[]): SentEvent[] {
    return responseCreates(sent).filter((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return response?.tool_choice === "auto" && metadata?.kind === "voice";
    });
  }

  function latestNativeResponseCreate(sent: SentEvent[]): SentEvent {
    const request = [...responseCreates(sent)].reverse().find((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return metadata?.kind === "voice";
    });
    if (!request) throw new Error("Expected a native voice response.create request");
    return request;
  }

  function continuationCreates(sent: SentEvent[]): SentEvent[] {
    return responseCreates(sent).filter((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      return response?.tool_choice === "none";
    });
  }

  function assistantSpeechCues(cues: ReactionCue[]): ReactionCue[] {
    return cues.filter((cue) => cue.source === "assistant" && cue.kind === "speech");
  }

  function functionOutputs(sent: SentEvent[]): SentEvent[] {
    return sent.filter((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "conversation.item.create" && item?.type === "function_call_output";
    });
  }

  function contextItems(sent: SentEvent[]): SentEvent[] {
    return sent.filter((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "conversation.item.create" && item?.role === "system";
    });
  }

  function markResponseCreated(client: InternalClient, sent: SentEvent[], id: string,
    metadataOverrides: Record<string, unknown> = {}): void {
    const request = latestNativeResponseCreate(sent);
    const response = request?.response as Record<string, unknown> | undefined;
    const metadata = response?.metadata as Record<string, unknown> | undefined;
    if (!metadata) throw new Error("Expected a reserved native voice response.create");
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata: { ...metadata, ...metadataOverrides } },
    }));
  }

  function plan(overrides: Partial<CharacterPlan> = {}): CharacterPlan {
    return {
      silent: false,
      beats: [
        {
          expression: "concerned",
          intensity: 0.95,
          anchor: "",
          intent: "comfort",
          gesture: "tilt-left",
          accent: "soften",
          effect: "none",
        },
        {
          expression: "curious",
          intensity: 0.82,
          anchor: "That really sucks",
          intent: "question",
          gesture: "lean-in",
          accent: "widen",
          effect: "none",
        },
      ],
      ...overrides,
    };
  }

  function functionArgumentsDone(
    client: InternalClient,
    responseId: string,
    callId: string,
    argumentsText: string,
    name = "perform_character",
  ): void {
    client.handleMessage(JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      call_id: callId,
      name,
      arguments: argumentsText,
    }));
  }

  function outputItemDone(
    client: InternalClient,
    responseId: string,
    callId: string,
    argumentsText: string,
  ): void {
    client.handleMessage(JSON.stringify({
      type: "response.output_item.done",
      response_id: responseId,
      item: {
        type: "function_call",
        name: "perform_character",
        call_id: callId,
        arguments: argumentsText,
      },
    }));
  }

  function responseDone(
    client: InternalClient,
    responseId: string,
    status: string = "completed",
    output: Array<Record<string, unknown>> = [],
  ): void {
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: responseId, status, output },
    }));
  }

  function startVoiceResponse(client: InternalClient, sent: SentEvent[], id: string): void {
    markResponseCreated(client, sent, id);
    client.outputLevel = 0.12;
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: id }));
  }

  function assistantTranscript(client: InternalClient, id: string, delta: string): void {
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: id,
      delta,
    }));
  }

  function advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(16, remaining);
      clock += step;
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }

  function setClock(now: number): void {
    clock = now;
    vi.setSystemTime(now);
  }

  function localInput(client: InternalClient, rms: number, now: number): void {
    setClock(now);
    client.processLocalInput(rms, now);
  }

  it("enables native control and sends the actual rendered state before an ordinary response", () => {
    const { client, sent } = createClient();

    expect(client.nativeCharacterEnabled).toBe(true);
    client.sendTextTurn("How are you doing?");

    const contexts = contextItems(sent);
    expect(contexts).toHaveLength(1);
    const item = contexts[0].item as Record<string, unknown>;
    const content = item.content as Array<Record<string, unknown>>;
    const contextText = content[0]?.text;
    expect(typeof contextText).toBe("string");
    expect(contextText).toContain("character_display");
    expect(contextText).toContain("curious");

    const contextIndex = sent.indexOf(contexts[0]);
    const responseIndex = sent.findIndex((event) => event.type === "response.create");
    expect(contextIndex).toBeGreaterThan(-1);
    expect(responseIndex).toBeGreaterThan(contextIndex);
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);
  });

  it("requires the echoed reservation before accepting output, rejects wrong metadata, and ignores duplicate creation", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Wait for the voice response.");
    const request = latestNativeResponseCreate(sent);
    const requestedResponse = request.response as Record<string, unknown>;
    const requestedMetadata = requestedResponse.metadata as Record<string, unknown>;
    expect(requestedResponse.tool_choice).toBe("auto");
    expect(request.event_id).toBe(requestedMetadata.request_id);
    expect(typeof requestedMetadata.turn_id).toBe("string");

    const unclaimedArguments = JSON.stringify(plan({ beats: [plan().beats[0]] }));
    // Provider output can race response.created. Until the matching request
    // metadata claims the id, it must not mutate audio state or run the tool.
    client.handleMessage(JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "voice-unclaimed",
      delta: "unexpected audio",
    }));
    functionArgumentsDone(client, "voice-unclaimed", "call-unclaimed", unclaimedArguments);
    expect(client.activeVoiceResponseId).toBeNull();
    expect(client.responseHasAudio).toBe(false);
    expect(cues).toEqual([]);
    expect(functionOutputs(sent)).toHaveLength(0);

    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: {
        id: "voice-wrong-request",
        metadata: { ...requestedMetadata, request_id: "voice-not-the-reservation" },
      },
    }));
    expect(client.activeVoiceResponseId).toBeNull();

    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id: "voice-claimed", metadata: requestedMetadata },
    }));
    expect(client.activeVoiceResponseId).toBe("voice-claimed");
    client.responseHasAudio = true;
    client.generatedTranscript = "keep this transcript";

    // Duplicate response.created is an acknowledgement replay, not a new
    // response. It must not reset the current transcript/audio state.
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id: "voice-claimed", metadata: requestedMetadata },
    }));
    expect(client.activeVoiceResponseId).toBe("voice-claimed");
    expect(client.responseHasAudio).toBe(true);
    expect(client.generatedTranscript).toBe("keep this transcript");
  });

  it("accepts one authored performance, gates anchored beats on playback, and deduplicates all tool-completion events", () => {
    const { client, sent, cues, transcripts } = createClient();
    client.sendTextTurn("That really sucks.");
    markResponseCreated(client, sent, "voice-1");
    const argumentsText = JSON.stringify(plan());

    functionArgumentsDone(client, "voice-1", "call-1", argumentsText);
    outputItemDone(client, "voice-1", "call-1", argumentsText);
    responseDone(client, "voice-1", "completed", [{
      type: "function_call", name: "perform_character", call_id: "call-1", arguments: argumentsText,
    }]);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ expression: "concerned", gesture: "tilt-left" });
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(transcripts).toEqual([]);
    expect(sent.some((event) => {
      const metadata = (event.response as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
      return metadata?.kind === "reaction_cue" || metadata?.kind === "speech_plan";
    })).toBe(false);

    // The second beat is not a queued animation shortcut. It becomes eligible
    // only once the assistant audio/caption clock is actually playing.
    client.responseHasAudio = true;
    client.outputMeterActive = true;
    client.outputWasAudible = true;
    client.outputLevel = 1;
    client.transcriptCanPlay = true;
    client.generatedTranscript = "That really sucks. I know.";
    // Keep the punctuation/end of the clause just ahead of the caption cursor;
    // the authored anchor should release at its first spoken words, not after
    // the whole sentence has already been presented.
    client.presentedAssistantTranscript = "That really sucks";
    client.assistantTranscriptComplete = false;
    client.emitAvailableSpeechCues();
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ expression: "curious", anchor: "That really sucks" });
  });

  it("uses exactly one tool-only continuation and never loops it", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Make a surprised face.");
    markResponseCreated(client, sent, "voice-tool-only");
    const argumentsText = JSON.stringify({
      silent: false,
      beats: [{
        expression: "surprised", intensity: 1, anchor: "", intent: "react", gesture: "lift", accent: "widen", effect: "none",
      }],
    });
    functionArgumentsDone(client, "voice-tool-only", "call-tool-only", argumentsText);
    responseDone(client, "voice-tool-only", "completed");

    expect(cues).toHaveLength(1);
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(continuationCreates(sent)).toHaveLength(1);
    expect((continuationCreates(sent)[0].response as Record<string, unknown>).tool_choice).toBe("none");

    // A duplicate response.done (including its output item) cannot create a
    // second acknowledgement, cue, or continuation.
    responseDone(client, "voice-tool-only", "completed", [{
      type: "function_call", name: "perform_character", call_id: "call-tool-only", arguments: argumentsText,
    }]);
    expect(cues).toHaveLength(1);
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(continuationCreates(sent)).toHaveLength(1);
  });

  it("does not create an extra spoken response when audio and a character tool share one response", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Tell me something fun.");
    markResponseCreated(client, sent, "voice-mixed");
    const argumentsText = JSON.stringify(plan({ beats: [plan().beats[0]] }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-mixed" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio.delta", response_id: "voice-mixed", delta: "audio" }));
    functionArgumentsDone(client, "voice-mixed", "call-mixed", argumentsText);
    responseDone(client, "voice-mixed", "completed", [{
      type: "function_call", name: "perform_character", call_id: "call-mixed", arguments: argumentsText,
    }, {
      type: "message", content: [{ type: "audio", transcript: "That is fun." }],
    }]);

    expect(cues).toHaveLength(1);
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(continuationCreates(sent)).toHaveLength(0);
  });

  it("recognizes final audio output paired with a tool even before audio buffer events arrive", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Give me a quick answer.");
    markResponseCreated(client, sent, "voice-final-mixed");
    const argumentsText = JSON.stringify({
      silent: false,
      beats: [{ expression: "neutral", intensity: 0.8, anchor: "", intent: "acknowledge", gesture: "still", accent: "none", effect: "none" }],
    });
    functionArgumentsDone(client, "voice-final-mixed", "call-final-mixed", argumentsText);

    // The provider can report the completed output inventory before WebRTC
    // has emitted started/delta events. The audio message is still spoken
    // output, so a second tool-only continuation would double-speak.
    responseDone(client, "voice-final-mixed", "completed", [{
      type: "function_call", name: "perform_character", call_id: "call-final-mixed", arguments: argumentsText,
    }, {
      type: "message",
      content: [{ type: "audio", transcript: "Here is the answer." }],
    }]);

    expect(cues).toHaveLength(1);
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(continuationCreates(sent)).toHaveLength(0);
  });

  it("carries a recognized job win through a short neutral audio-only reply", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("I finally got the job I really wanted!");
    startVoiceResponse(client, sent, "voice-job-win");
    assistantTranscript(client, "voice-job-win", "Oh, yes. That’s huge, and you really went for the one you wanted.");
    advance(16);

    // The explicit user reaction is expected first. The audio-only fallback
    // must then preserve that meaning through the short, neutral first thought.
    const speech = assistantSpeechCues(cues);
    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({
      source: "assistant",
      expression: "delighted",
      intent: "celebrate",
      confidence: 0.68,
      effect: "none",
    });
  });

  it("carries a recognized correction through a short same-topic audio-only reply", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("I received a rejection after thinking it was good news.");
    startVoiceResponse(client, sent, "voice-correction-fallback");
    assistantTranscript(client, "voice-correction-fallback", "Oof, that’s a tough turn, especially after thinking it was good news.");
    advance(16);

    const speech = assistantSpeechCues(cues);
    expect(speech.length).toBeGreaterThanOrEqual(1);
    expect(speech[0]).toMatchObject({
      source: "assistant",
      expression: "concerned",
      intent: "comfort",
      effect: "none",
    });
    expect(speech[0].anchor).toContain("Oof");
    expect(speech[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("does not carry a recognized reaction across a pivot, a new question, or an authored native plan", () => {
    const inspectPrepared = (reply: string): ReactionCue[] => {
      const { client, sent } = createClient();
      client.sendTextTurn("I finally got the job I really wanted!");
      startVoiceResponse(client, sent, `voice-fallback-${client.fastSpeechCues.size}-${reply.length}`);
      assistantTranscript(client, client.activeVoiceResponseId ?? "", reply);
      return [...client.fastSpeechCues.values()].map((entry) => entry.cue);
    };

    const pivot = inspectPrepared("Oh, yes. That’s huge, but what do you want to do next?");
    expect(pivot.length).toBeGreaterThanOrEqual(2);
    expect(pivot[0]).toMatchObject({ expression: "delighted", intent: "celebrate" });
    expect(pivot.at(-1)).toMatchObject({ expression: "curious", intent: "question" });

    const question = inspectPrepared("Oh, yes. That’s huge. What time is the interview?");
    expect(question.length).toBeGreaterThanOrEqual(2);
    expect(question[0]).toMatchObject({ expression: "delighted", intent: "celebrate" });
    expect(question.at(-1)).toMatchObject({ expression: "curious", intent: "question" });

    const { client, sent, cues } = createClient();
    client.sendTextTurn("I finally got the job I really wanted!");
    startVoiceResponse(client, sent, "voice-authored-plan-priority");
    const argumentsText = JSON.stringify({
      silent: false,
      beats: [{
        expression: "delighted", intensity: 0.95, anchor: "", intent: "celebrate",
        gesture: "lift", accent: "widen", effect: "none",
      }],
    });
    functionArgumentsDone(client, "voice-authored-plan-priority", "call-authored-plan-priority", argumentsText);
    assistantTranscript(client, "voice-authored-plan-priority", "Oh, yes. That’s huge, and you really went for it.");
    advance(16);

    expect(client.fastSpeechCues.size).toBe(0);
    expect(assistantSpeechCues(cues)).toEqual([]);
  });

  it("lets sustained overlapped native input claim the next turn without waiting for ASR", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-old-sustained");
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "sustained" }));

    // The user keeps the floor for more than the 1.5s sustained threshold.
    // The old response then drains naturally while the user is still speaking.
    advance(1_700);
    responseDone(client, "voice-old-sustained", "completed");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-old-sustained" }));
    advance(100);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "sustained" }));

    // No transcript event is required for a clearly sustained turn. The first
    // response is the old answer; the second is requested at the local stop.
    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);
  });

  it("keeps a short overlapped input inside the ASR grace window", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-old-brief");
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "brief" }));

    advance(700);
    responseDone(client, "voice-old-brief", "completed");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-old-brief" }));
    advance(100);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "brief" }));

    // A short unknown overlap still gets a chance to resolve as “yeah” before
    // the app starts a new spoken response.
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);
    advance(849);
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);
    advance(1);
    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);
  });

  it("measures sustained manual input at the local pause, not at a delayed commit acknowledgement", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-old-manual");
    client.manualTurnDetection = true;

    // Drive the real client-owned detector. The old response ends midway
    // through a sustained input; the local pause later emits one commit.
    localInput(client, 0, 0);
    for (let now = 16; now <= 160; now += 16) localInput(client, 0.03, now);
    for (let now = 176; now <= 1_000; now += 16) localInput(client, 0.03, now);
    responseDone(client, "voice-old-manual", "completed");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-old-manual" }));
    for (let now = 1_016; now <= 2_100; now += 16) localInput(client, 0.03, now);
    for (let now = 2_116; now <= 2_600; now += 16) localInput(client, 0, now);

    expect(sent.filter((event) => event.type === "input_audio_buffer.commit")).toHaveLength(1);
    expect(client.inputHeldFloor).toBe(true);
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);

    // The provider ACK is deliberately delayed, but still arrives before the
    // commit watchdog. The held-floor measurement must survive that delay and
    // avoid reopening the short-utterance ASR grace window.
    setClock(3_000);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "manual-sustained" }));
    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);
  });

  it("releases one queued native reply when clear arrives before cancelled generation.done", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-clear-first");
    client.queuedUserTurn = true;
    client.pendingUserTurnId = "0:2";
    client.beginOutputClear();
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.clear" }));

    // The clear acknowledgement can precede the provider's cancelled
    // response.done. Clearing must not release the queued turn while the old
    // generation is still marked active.
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-clear-first" }));
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);
    expect(client.responseActive).toBe(true);

    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-clear-first", status: "cancelled" },
    }));
    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);

    // Once the new reservation is claimed, any late old lifecycle events are
    // fenced and cannot reset the new response or append stale captions.
    markResponseCreated(client, sent, "voice-new-after-clear");
    client.generatedTranscript = "new topic response";
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-clear-first" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: "voice-clear-first",
      delta: " stale old words",
    }));
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-clear-first", status: "cancelled" },
    }));
    expect(client.activeVoiceResponseId).toBe("voice-new-after-clear");
    expect(client.generatedTranscript).toBe("new topic response");
  });

  it("queues exactly once when cancelled generation.done arrives before clear", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-done-first");
    client.queuedUserTurn = true;
    client.pendingUserTurnId = "0:2";
    client.beginOutputClear();

    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-done-first", status: "cancelled" },
    }));
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-done-first" }));
    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);
  });

  it("does not let a stale output-silence timeout end a newer native response", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    startVoiceResponse(client, sent, "voice-old-silence-timer");

    // Model the fallback timer created before the new response reservation.
    // Its callback is deliberately the same state mutation as the legacy
    // meter path: it must be cancelled when the new response starts.
    client.responseActive = false;
    client.outputMeterActive = false;
    client.queuedUserTurn = true;
    client.pendingUserTurnId = "0:2";
    client.requestQueuedResponse();
    const staleTimer = window.setTimeout(() => {
      client.outputMeterActive = false;
      client.voiceResponseEnded = true;
    }, 900);
    client.outputSilenceTimer = staleTimer;

    markResponseCreated(client, sent, "voice-new-silence-timer");
    client.outputLevel = 0.12;
    client.handleMessage(JSON.stringify({
      type: "output_audio_buffer.started",
      response_id: "voice-new-silence-timer",
    }));
    advance(900);

    expect(client.outputSilenceTimer).toBeNull();
    expect(client.outputMeterActive).toBe(true);
    expect(client.voiceResponseEnded).toBe(false);
  });

  it("performs a silent face beat immediately without speaking or continuing", () => {
    const { client, sent, cues, transcripts } = createClient();
    client.sendTextTurn("Just look surprised.");
    markResponseCreated(client, sent, "voice-silent");
    const argumentsText = JSON.stringify({
      silent: true,
      beats: [{
        expression: "surprised", intensity: 1, anchor: "", intent: "react", gesture: "lift", accent: "widen", effect: "none",
      }],
    });
    functionArgumentsDone(client, "voice-silent", "call-silent", argumentsText);
    responseDone(client, "voice-silent", "completed");

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ expression: "surprised", kind: "reaction" });
    expect(transcripts).toEqual([]);
    expect(functionOutputs(sent)).toHaveLength(1);
    expect(continuationCreates(sent)).toHaveLength(0);
  });

  it("rejects invalid arguments once and releases a bounded tool-disabled continuation", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("React to this.");
    markResponseCreated(client, sent, "voice-invalid");
    functionArgumentsDone(client, "voice-invalid", "call-invalid", "{not-json");
    responseDone(client, "voice-invalid", "completed");
    responseDone(client, "voice-invalid", "completed");

    expect(cues).toHaveLength(0);
    expect(functionOutputs(sent)).toHaveLength(1);
    const output = functionOutputs(sent)[0].item as Record<string, unknown>;
    expect(output.output).toContain("invalid_arguments");
    expect(continuationCreates(sent)).toHaveLength(1);
  });

  it("surfaces a clean error when a native response completes with no audio or tool", () => {
    const { client, sent, errors, phases } = createClient();
    client.sendTextTurn("Say hello.");
    markResponseCreated(client, sent, "voice-empty");

    // A provider response.done with no output has no later playback event that
    // could release the thinking state. It must fail visibly and close the
    // session rather than leaving the character silently thinking forever.
    responseDone(client, "voice-empty", "completed");

    expect(errors).toEqual(["The voice returned no reply. Please try again."]);
    expect(phases.at(-1)).toBe("error");
    expect(client.responseActive).toBe(false);
    expect(nativeInitialResponseCreates(sent)).toHaveLength(1);
    advance(5_000);
    expect(errors).toHaveLength(1);
    expect(phases.at(-1)).toBe("error");
  });

  it("ignores stale, mismatched, and cancelled tool events", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Stay with me.");
    markResponseCreated(client, sent, "voice-current");
    const argumentsText = JSON.stringify(plan());

    functionArgumentsDone(client, "voice-other", "call-stale", argumentsText);
    outputItemDone(client, "voice-other", "call-stale", argumentsText);
    responseDone(client, "voice-other", "cancelled", [{
      type: "function_call", name: "perform_character", call_id: "call-stale", arguments: argumentsText,
    }]);
    responseDone(client, "voice-current", "cancelled", [{
      type: "function_call", name: "perform_character", call_id: "call-cancelled", arguments: argumentsText,
    }]);

    expect(cues).toHaveLength(0);
    expect(functionOutputs(sent)).toHaveLength(0);
    expect(continuationCreates(sent)).toHaveLength(0);
  });

  it("publishes the newest rendered App context only after the old reply is cleared", () => {
    const { client, sent } = createClient();
    client.sendTextTurn("Finish the old answer.");
    markResponseCreated(client, sent, "voice-old");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-old" }));

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "new-topic" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "new-topic",
      delta: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "new-topic",
      transcript: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "new-topic" }));
    client.checkTalkOver("phrase");
    advance(250);

    const clearRequestIndex = sent.findIndex((event) => event.type === "output_audio_buffer.clear");
    expect(clearRequestIndex).toBeGreaterThan(-1);
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-old", status: "cancelled" },
    }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));

    const contexts = contextItems(sent);
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    const latestContext = contexts.at(-1)!;
    const latestItem = latestContext.item as Record<string, unknown>;
    const latestContent = latestItem.content as Array<Record<string, unknown>>;
    const latestText = String(latestContent[0]?.text ?? "");
    expect(latestText).toContain("newest point directly");
    expect(latestText).toContain("curious");
    expect(sent.indexOf(latestContext)).toBeGreaterThan(clearRequestIndex);
    expect(sent.indexOf(latestContext)).toBeLessThan(sent.findIndex((event, index) => (
      index > sent.indexOf(latestContext)
      && event.type === "response.create"
    )));
  });

  it("allows a fresh native performance after a new logical user turn", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("First thought.");
    markResponseCreated(client, sent, "voice-first");
    const firstText = JSON.stringify({
      silent: false,
      beats: [{ expression: "curious", intensity: 0.8, anchor: "", intent: "react", gesture: "lean-in", accent: "widen", effect: "none" }],
    });
    functionArgumentsDone(client, "voice-first", "call-first", firstText);
    responseDone(client, "voice-first", "completed");

    // The tool-only continuation is now the old logical response. Once it
    // finishes, a new user turn gets a new plan budget and fresh cue ids.
    markResponseCreated(client, sent, "voice-continuation");
    responseDone(client, "voice-continuation", "completed", [{
      type: "message",
      content: [{ type: "audio", transcript: "Okay." }],
    }]);
    client.sendTextTurn("New topic.");
    markResponseCreated(client, sent, "voice-second");
    const secondText = JSON.stringify({
      silent: false,
      beats: [{ expression: "delighted", intensity: 0.9, anchor: "", intent: "celebrate", gesture: "lift", accent: "spark", effect: "none" }],
    });
    functionArgumentsDone(client, "voice-second", "call-second", secondText);

    expect(cues).toHaveLength(2);
    expect(cues[0].turnId).not.toBe(cues[1].turnId);
    expect(functionOutputs(sent)).toHaveLength(2);
  });

  it("does not let a pending tool-only continuation steal a newer spoken turn", () => {
    const { client, sent, cues } = createClient();
    client.sendTextTurn("Old topic.");
    markResponseCreated(client, sent, "voice-old");
    const oldText = JSON.stringify({
      silent: false,
      beats: [{ expression: "concerned", intensity: 0.9, anchor: "", intent: "react", gesture: "tilt-left", accent: "soften", effect: "none" }],
    });
    functionArgumentsDone(client, "voice-old", "call-old", oldText);

    // A committed overlap is already taking the floor when the tool-only
    // response finishes. The old response may be acknowledged, but its
    // continuation must wait instead of speaking over the new user.
    client.userSpeechActive = true;
    responseDone(client, "voice-old", "completed");
    expect(continuationCreates(sent)).toHaveLength(0);

    client.sendTextTurn("New topic.");
    markResponseCreated(client, sent, "voice-new");
    const newText = JSON.stringify({
      silent: false,
      beats: [{ expression: "curious", intensity: 0.9, anchor: "", intent: "question", gesture: "lean-in", accent: "widen", effect: "none" }],
    });
    functionArgumentsDone(client, "voice-new", "call-new", newText);

    expect(nativeInitialResponseCreates(sent)).toHaveLength(2);
    expect(cues).toHaveLength(2);
    expect(functionOutputs(sent)).toHaveLength(2);
  });
});
