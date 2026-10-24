import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient, type ReactionDiagnostic } from "./realtime";
import type { ReactionCue } from "./reaction-cues";
import { captionWindow, captionWords, type CaptionPlan, type PlaybackWord } from "./spoken-caption";
import { SpeechTimeline, ACTING_LEAD_MS } from "./caption-clock";

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
  voiceResponseEnded: boolean;
  outputLevel: number;
  outputPlaybackEnded: boolean;
  outputContext: AudioContext | null;
  outputFirstAudibleAt: number | null;
  outputFirstAudioContextTime: number | null;
  playbackElapsedMs: () => number;
  responseHasAudio: boolean;
  responseInterrupted: boolean;
  activeVoiceResponseId: string | null;
  activeInputItemId: string | null;
  userSpeechActive: boolean;
  outputClearPending: boolean;
  pendingOutputClearResponseId: string | null;
  timeline: SpeechTimeline;
  pendingOutputBoundary: { at: number; boundary: "word" | "phrase" | "sentence" } | null;
  presentedAssistantTranscript: string;
  transcriptBuffer: string;
  userTranscript: string;
  startTranscriptPlayback: () => void;
  emitAvailableSpeechCues: () => void;
};

describe("Realtime talk-over tolerance", () => {
  let clock = 0;

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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createBusyClient() {
    const sent: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const client = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onError: () => undefined,
    }) as unknown as InternalClient;
    client.channel = {
      readyState: "open",
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      close: () => undefined,
    };
    client.outputMeterActive = true;
    client.responseActive = true;
    return { client, sent, phases };
  }

  function createTextClient() {
    const sent: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const transcripts: string[] = [];
    const cues: ReactionCue[] = [];
    const diagnostics: ReactionDiagnostic[] = [];
    const errors: string[] = [];
    const words: PlaybackWord[] = [];
    const captionPlans: CaptionPlan[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: (delta) => transcripts.push(delta),
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onPlaybackWord: (word) => words.push(word),
      onCaptionPlan: (plan) => captionPlans.push(plan),
      onReactionCue: (cue) => cues.push(cue),
      onReactionDiagnostic: (event) => diagnostics.push(event),
      onError: (message) => errors.push(message),
    });
    const client = voice as unknown as InternalClient;
    client.channel = {
      readyState: "open",
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      close: () => undefined,
    };
    return { client, sent, phases, transcripts, cues, diagnostics, errors, words, captionPlans };
  }

  function reactionRequest(sent: Array<Record<string, unknown>>) {
    return sent.find((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return event.type === "response.create" && metadata?.kind === "reaction_cue";
    }) as { response: { metadata: Record<string, string> }; event_id: string };
  }

  function reactionRequests(sent: Array<Record<string, unknown>>) {
    return sent.filter((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return event.type === "response.create" && metadata?.kind === "reaction_cue";
    });
  }

  function speechPlanRequests(sent: Array<Record<string, unknown>>) {
    return sent.filter((event) => {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return event.type === "response.create" && metadata?.kind === "speech_plan";
    });
  }

  function markVoiceResponseCreated(client: InternalClient, id = "voice-1") {
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id } }));
  }

  function completeReaction(
    client: InternalClient,
    request: { response: { metadata: Record<string, string> } },
    id = "reaction-1",
    result = {
      expression: "proud",
      intensity: 0.9,
      effect: "confetti",
      confidence: 0.95,
      anchor: "got the job",
    },
  ) {
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata: request.response.metadata },
    }));
    client.handleMessage(JSON.stringify({
      type: "response.output_text.delta",
      response_id: id,
      delta: JSON.stringify(result),
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  function completeSpeechPlan(
    client: InternalClient,
    request: Record<string, unknown>,
    id = "speech-plan-response-1",
    result = {
      cues: [
        {
          kind: "speech",
          phraseIndex: 0,
          expression: "delighted",
          intensity: 0.85,
          effect: "none",
          confidence: 0.92,
          gesture: "lift",
          accent: "spark",
          anchor: "First, this is a thoughtful start",
        },
        {
          kind: "speech",
          phraseIndex: 1,
          expression: "curious",
          intensity: 0.62,
          effect: "none",
          confidence: 0.82,
          gesture: "lean-in",
          accent: "widen",
          anchor: "Second, let us look closer",
        },
      ],
    },
  ) {
    const response = request.response as Record<string, unknown>;
    const metadata = response.metadata as Record<string, string>;
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata },
    }));
    client.handleMessage(JSON.stringify({
      type: "response.output_text.delta",
      response_id: id,
      delta: JSON.stringify(result),
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
  }

  it("does not cancel or queue another response for a completed quiet acknowledgement", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "yeah",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yeah",
    }));

    expect(sent).toEqual([]);

    advance(8_500);
    client.checkTalkOver();
    expect(sent).toEqual([]);
  });

  it("does not re-queue a backchannel when ASR completes before delayed VAD stop", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "ack" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "ack",
      transcript: "yeah",
    }));

    // Some sessions deliver the final auxiliary transcript before VAD emits
    // speech_stopped. That late stop must not turn the acknowledgement into a
    // second response once the old audio naturally drains.
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    expect(sent).toEqual([]);

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "completed" } }));
    expect(sent).toEqual([]);
  });

  it("re-opens a completed acknowledgement if a substantive continuation arrives", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "ack-then-topic" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "ack-then-topic",
      transcript: "yeah",
    }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "ack-then-topic",
      delta: " actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    client.handleMessage(JSON.stringify({ type: "response.done" }));

    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(1);
  });

  it("hands a substantive topic change off on a short bounded fallback", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic" }));
    advance(100);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "topic",
      delta: "By the way, what are you doing this weekend",
    }));

    advance(1_099);
    expect(sent).toEqual([]);
    advance(1);
    client.checkTalkOver();
    expect(sent).toEqual([]);
    advance(179);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("waits for the upcoming timeline boundary instead of cutting through a known sentence", () => {
    const { client, sent } = createBusyClient();
    client.pendingOutputBoundary = { at: 2_000, boundary: "sentence" };
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "topic",
      delta: "By the way, tell me about the weather",
    }));
    advance(700);
    client.checkTalkOver();

    // The old 1.2 s wall has passed, but the next known sentence ends at 2 s.
    expect(sent).toEqual([]);
    advance(800);
    client.checkTalkOver();
    advance(139);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("derives a future sentence deadline from the playback timeline before punctuation is released", () => {
    const { client, sent } = createBusyClient();
    client.responseHasAudio = true;
    client.outputFirstAudibleAt = 0;
    client.timeline.updateText(
      "I want to make sure I understand what happened before I answer you clearly. Then we can talk about what to do next.",
      true,
    );
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "topic",
      delta: "By the way, tell me about the weather",
    }));
    advance(700);
    client.checkTalkOver();

    // No pending punctuation callback has fired yet, but the timeline already
    // knows the sentence is still ahead. The safety wall must not cut here.
    expect(sent).toEqual([]);
  });

  it("keeps an id-bearing audio drain event valid after generation.done", () => {
    const { client } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-ga" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-ga" }));
    expect(client.outputMeterActive).toBe(true);

    // GA can finish generation before the remaining WebRTC output drains.
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-ga", status: "completed" } }));
    expect(client.responseActive).toBe(false);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-ga" }));
    expect(client.outputMeterActive).toBe(false);
  });

  it("releases a matching unsolicited clear after generation without leaking unheard captions", () => {
    const { client, sent, phases, transcripts } = createTextClient();
    client.sendTextTurn("Good news.");
    markVoiceResponseCreated(client, "voice-yeah");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-yeah" }));
    client.presentedAssistantTranscript = "Nice work.";
    client.transcriptBuffer = " You earned it.";
    const transcriptsBeforeClear = [...transcripts];

    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-yeah", status: "completed" } }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "ack" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-yeah" }));

    expect(client.outputMeterActive).toBe(false);
    expect(client.outputPlaybackEnded).toBe(true);
    expect(client.voiceResponseEnded).toBe(true);
    expect(client.activeVoiceResponseId).toBeNull();
    expect(client.presentedAssistantTranscript).toBe("Nice work.");
    expect(client.transcriptBuffer).toBe("");
    expect(transcripts).toEqual(transcriptsBeforeClear);
    expect(phases.at(-1)).toBe("listening");
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(1);
  });

  it("ignores an unsolicited clear for an unrelated response id while the current response drains", () => {
    const { client, phases, transcripts } = createTextClient();
    client.sendTextTurn("Keep talking.");
    markVoiceResponseCreated(client, "voice-current");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-current" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: "voice-current",
      delta: "The current thought is still playing.",
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-current", status: "completed" } }));
    const transcriptBeforeStaleClear = [...transcripts];

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-other" }));

    expect(client.activeVoiceResponseId).toBe("voice-current");
    expect(client.outputMeterActive).toBe(true);
    expect(client.outputPlaybackEnded).toBe(false);
    expect(client.voiceResponseEnded).toBe(false);
    expect(transcripts).toEqual(transcriptBeforeStaleClear);
    expect(phases.at(-1)).toBe("speaking");
  });

  it("keeps a generating response resumable when its current output buffer is cleared", () => {
    const { client, phases } = createTextClient();
    client.sendTextTurn("Continue the thought.");
    markVoiceResponseCreated(client, "voice-stream");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-stream" }));

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-stream" }));

    expect(client.responseActive).toBe(true);
    expect(client.activeVoiceResponseId).toBe("voice-stream");
    expect(client.outputMeterActive).toBe(false);
    expect(client.voiceResponseEnded).toBe(false);
    expect(phases.at(-1)).toBe("listening");

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-stream" }));
    expect(client.responseActive).toBe(true);
    expect(client.activeVoiceResponseId).toBe("voice-stream");
    expect(client.outputMeterActive).toBe(true);
    expect(client.voiceResponseEnded).toBe(false);
    expect(phases.at(-1)).toBe("speaking");
  });

  it("does not create a second response when delayed ASR identifies the overlap as a backchannel", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("Good news.");
    markVoiceResponseCreated(client, "voice-backchannel");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-backchannel" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-backchannel", status: "completed" } }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "ack" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-backchannel" }));

    // VAD can stop before the auxiliary transcript arrives. The completed
    // acknowledgement must still be treated as a backchannel after the clear.
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "ack" }));
    advance(450);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "ack",
      transcript: "yeah",
    }));
    advance(8_500);
    client.checkTalkOver();

    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(1);
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(0);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toHaveLength(0);
  });

  it("ignores id-bearing lifecycle events from another voice response while A drains", () => {
    const { client, transcripts } = createTextClient();
    client.sendTextTurn("Start the first answer.");
    markVoiceResponseCreated(client, "voice-a");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-a" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: "voice-a",
      delta: "The first answer is still playing.",
    }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-a", status: "completed" } }));
    expect(client.responseActive).toBe(false);
    expect(client.activeVoiceResponseId).toBe("voice-a");
    expect(client.outputMeterActive).toBe(true);
    const transcriptBeforeStaleEvents = [...transcripts];
    const bufferBeforeStaleEvents = client.transcriptBuffer;

    // A late parallel response must not replace the active response, stop its
    // meter, or append foreign transcript text. The OOB analyzer route runs
    // before this fence, so these are strictly voice lifecycle events.
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-b" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-b" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: "voice-b",
      delta: "This stale answer must be ignored.",
    }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-b" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-b", status: "completed" } }));

    expect(client.activeVoiceResponseId).toBe("voice-a");
    expect(client.outputMeterActive).toBe(true);
    expect(client.responseInterrupted).toBe(false);
    expect(transcripts).toEqual(transcriptBeforeStaleEvents);
    expect(client.transcriptBuffer).toBe(bufferBeforeStaleEvents);

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "voice-a" }));
    expect(client.outputMeterActive).toBe(false);
  });

  it("does not let an old speech stop end a newer active input item", () => {
    const { client } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "input-old" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "input-new" }));

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "input-old" }));
    expect(client.activeInputItemId).toBe("input-new");
    expect(client.userSpeechActive).toBe(true);

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "input-new" }));
    expect(client.userSpeechActive).toBe(false);
  });

  it("uses the newest input after a fast second topic arrives during the fade", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-old" } }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "first" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: "Tell me about the weekend",
    }));
    client.checkTalkOver("phrase");

    // A newer turn starts before the old cancel/clear acknowledgement. Its
    // pending id must win when the old buffer finally releases the turn.
    advance(60);
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "second" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "second",
      delta: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));

    advance(80);
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toHaveLength(1);
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "some-other-old-response" }));
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(0);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));

    const voiceResponses = sent.filter((event) => event.type === "response.create" && event.response === undefined);
    expect(voiceResponses).toHaveLength(1);

    // A delayed old completion/clear must not end the newly reserved turn.
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-new" } }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));
    expect(client.responseActive).toBe(true);
  });

  it("releases a queued topic after a missing clear acknowledgement", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-old" } }));
    client.outputMeterActive = true;
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "topic",
      transcript: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.checkTalkOver("phrase");
    advance(140);
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "cancelled" } }));

    // The app has already requested clear, but no acknowledgement arrives.
    // Its bounded fallback must still let the latest turn start.
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(0);
    advance(1_000);
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(1);
  });

  it("ignores a timed-out old clear before accepting the next response's matching clear", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-old-timeout" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-old-timeout" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic-one" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "topic-one",
      delta: "Actually, tell me about the weather",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "topic-one" }));
    client.checkTalkOver("phrase");
    advance(140);
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old-timeout", status: "cancelled" } }));
    expect(client.outputClearPending).toBe(true);

    // The old clear acknowledgement arrives after our bounded timeout. It is
    // correlated with the retired old id and must not release a later turn.
    advance(1_000);
    expect(client.outputClearPending).toBe(false);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old-timeout" }));
    expect(client.outputClearPending).toBe(false);

    // The queued latest turn is now reserved; once its response has an id,
    // only its own clear may release the next queued input.
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "voice-current" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-current" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "topic-two" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "topic-two",
      delta: "Now tell me about tomorrow",
    }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "topic-two" }));
    client.checkTalkOver("phrase");
    advance(140);
    expect(client.outputClearPending).toBe(true);
    expect(client.pendingOutputClearResponseId).toBe("voice-current");

    // An uncorrelatable old ack must not consume a pending clear with a known
    // response id; the bounded fallback remains available if the real ack is
    // lost.
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared" }));
    expect(client.outputClearPending).toBe(true);
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(1);

    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-current", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-current" }));
    expect(client.outputClearPending).toBe(false);
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(2);
  });

  it("waits for a known output phrase boundary, then fades before canceling and clearing", () => {
    const { client, sent, phases } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Actually, that correction matters",
    }));
    client.checkTalkOver("phrase");

    expect(sent).toEqual([]);
    advance(139);
    expect(sent).toEqual([]);

    advance(1);
    expect(sent).toEqual([
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    expect(phases.at(-1)).toBe("listening");
  });

  it("clears buffered playback without cancel when generation has already finished", () => {
    const { client, sent, phases } = createBusyClient();
    client.responseActive = false;
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Actually, that correction matters",
    }));
    client.outputWasAudible = true;
    client.outputQuietSince = clock - 200;
    client.checkTalkOver();
    expect(sent).toEqual([]);
    advance(139);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([{ type: "output_audio_buffer.clear" }]);
    expect(phases.at(-1)).toBe("listening");
  });

  it("cancels a pending fade when the client closes", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Actually, that correction matters",
    }));
    client.checkTalkOver("phrase");
    advance(60);
    client.close(false);
    advance(500);

    expect(sent).toEqual([]);
  });

  it("uses the earlier bounded 2.2 s safety path for sustained speech with no transcript", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

    // Sustained unknown speech qualifies after the 1.5 s floor. With no
    // transcript or usable phrase boundary, the conservative handoff still
    // waits for the finite 2.2 s fallback rather than cutting at the first
    // brief overlap.
    advance(2_200);
    client.checkTalkOver();
    expect(sent).toEqual([]);
    advance(250);

    expect(sent).toEqual([
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("uses string-only API metadata and isolates validation errors by the original client id", () => {
    const { client, sent, errors, phases, diagnostics } = createTextClient();
    client.sendTextTurn("Tell me a little story.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "What a surprise! That is a lovely idea." }));
    const [plan] = speechPlanRequests(sent);
    expect(plan).toBeDefined();
    for (const request of sent) {
      const response = request.response as { metadata?: Record<string, unknown> } | undefined;
      for (const value of Object.values(response?.metadata ?? {})) expect(typeof value).toBe("string");
    }
    const phaseCount = phases.length;
    client.handleMessage(JSON.stringify({
      type: "error",
      event_id: "server-event-unrelated-id",
      error: { event_id: plan.event_id, message: "A visual analysis request was invalid." },
    }));
    expect(client.responseActive).toBe(true);
    expect(errors).toEqual([]);
    expect(phases).toHaveLength(phaseCount);
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: "failed", reason: "speech_plan_error" }));
  });

  it("routes a contextual reaction response without touching the voice lifecycle", () => {
    const { client, sent, phases, transcripts, cues, diagnostics, errors } = createTextClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    const phaseCount = phases.length;
    const responseCount = sent.filter((event) => event.type === "response.create").length;

    completeReaction(client, request);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ expression: "proud", effect: "confetti", turnId: request.response.metadata.turn_id });
    expect(client.responseActive).toBe(true);
    expect(phases).toHaveLength(phaseCount);
    expect(transcripts).toEqual([]);
    expect(errors).toEqual([]);
    expect(diagnostics.map((event) => event.state)).toContain("requested");
    expect(diagnostics.map((event) => event.state)).toContain("received");
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(responseCount);
  });

  it("consumes private function arguments without turning them into speech or transcript text", () => {
    const { client, sent, cues, transcripts, phases } = createTextClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);
    expect(request.response).toMatchObject({ conversation: "none", tool_choice: { type: "function", name: "render_reaction" } });
    markVoiceResponseCreated(client);
    const phaseCount = phases.length;
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "reaction-tool", metadata: request.response.metadata } }));
    const argumentsText = JSON.stringify({ expression: "proud", intensity: 0.9, effect: "confetti", confidence: 0.95, anchor: "got the job" });
    client.handleMessage(JSON.stringify({ type: "response.function_call_arguments.done", response_id: "reaction-tool", arguments: argumentsText }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "reaction-tool", status: "completed" } }));
    expect(cues).toMatchObject([{ expression: "proud", effect: "confetti" }]);
    expect(transcripts).toEqual([]);
    expect(phases).toHaveLength(phaseCount);
    expect(client.responseActive).toBe(true);
  });

  it("recovers private function arguments from response.done when delta events were missing", () => {
    const { client, sent, cues } = createTextClient();
    client.sendTextTurn("I finally got the job!");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "reaction-tool-done", metadata: request.response.metadata } }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: {
      id: "reaction-tool-done", status: "completed", output: [{ type: "function_call", name: "render_reaction",
        arguments: JSON.stringify({ expression: "proud", intensity: 0.9, effect: "confetti", confidence: 0.95, anchor: "got the job" }) }],
    } }));
    expect(cues).toHaveLength(1);
    expect(client.responseActive).toBe(true);
  });

  it("sends each reaction analyzer an explicit bounded input instead of inherited session context", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("I finally got the job!");
    markVoiceResponseCreated(client, "voice-1");
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: "That is a big deal.",
    }));
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "voice-1", status: "completed" },
    }));

    client.sendTextTurn("Actually, I misread the email. I did not get the job. It was a rejection.");
    const requests = reactionRequests(sent);
    expect(requests).toHaveLength(2);

    const latestResponse = requests.at(-1)?.response as Record<string, unknown>;
    const input = latestResponse.input as Array<Record<string, unknown>> | undefined;
    expect(input).toHaveLength(1);
    expect(input?.[0]).toMatchObject({ type: "message", role: "user" });
    const content = input?.[0].content as Array<Record<string, unknown>> | undefined;
    expect(content).toHaveLength(1);
    const boundedInput = content?.[0].text;
    expect(typeof boundedInput).toBe("string");
    expect(boundedInput).toContain("Actually, I misread the email. I did not get the job. It was a rejection.");
    expect(boundedInput).toContain("That is a big deal.");
    expect(boundedInput).not.toContain("You are a private reaction director");
    expect(latestResponse.instructions).toContain("You are a private reaction director");
  });

  it("releases speech cues at the matching word or bounded anticipation, never on generation", () => {
    const { client, sent, transcripts, cues, diagnostics } = createTextClient();
    const assistantText = "First, this is a thoughtful start. Second, let us look closer.";
    client.sendTextTurn("Give me a thoughtful answer.");
    markVoiceResponseCreated(client, "voice-plan-1");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: assistantText,
    }));

    const plans = speechPlanRequests(sent);
    expect(plans).toHaveLength(1);
    const planResponse = plans[0].response as Record<string, unknown>;
    const planInput = planResponse.input as Array<Record<string, unknown>>;
    const planContent = planInput[0].content as Array<Record<string, unknown>>;
    expect(planContent[0].text).toContain(assistantText);
    expect(planResponse.instructions).toContain("private performance director");

    completeSpeechPlan(client, plans[0]);
    expect(cues).toEqual([]);

    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    expect(transcripts[0]).toBe("First, ");
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ kind: "speech", phraseIndex: 0 });

    const reference = new SpeechTimeline();
    reference.updateText(assistantText);
    const secondAt = reference.words.find((word) => word.text === "Second,")!.startMs;
    advance(secondAt - ACTING_LEAD_MS - 32);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ kind: "speech", phraseIndex: 0, anchor: "First, this is a thoughtful start" });
    expect(diagnostics.map((event) => event.state)).toContain("received");
    advance(64);
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ kind: "speech", phraseIndex: 1 });
  });

  it("does not let a late turn reaction overwrite an already emitted phrase beat", () => {
    const { client, sent, cues, diagnostics } = createTextClient();
    const assistantText = "First, this is a thoughtful start. Second, let us look closer.";
    client.sendTextTurn("I've got the job I really wanted!");
    const reaction = reactionRequest(sent);
    markVoiceResponseCreated(client, "voice-plan-2");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: assistantText,
    }));
    const [plan] = speechPlanRequests(sent).slice(-1);
    completeSpeechPlan(client, plan);

    // The caption cursor is inside the anchored phrase, so a late plan may
    // still perform the current beat but must not replay a finished phrase.
    client.presentedAssistantTranscript = "First, this is";
    client.emitAvailableSpeechCues();
    expect(cues).toHaveLength(1);
    expect(cues[0].kind).toBe("speech");

    completeReaction(client, reaction, "reaction-late", {
      expression: "proud",
      intensity: 0.9,
      effect: "confetti",
      confidence: 0.95,
      anchor: "got the job",
    });

    expect(cues).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      state: "rejected",
      reason: "reaction_after_speech_plan",
    }));
  });

  it("plans the final single clause when generation finished during an earlier plan", () => {
    const { client, sent } = createTextClient();
    const assistantText = "First, this is a thoughtful start. Second, let us look closer. Last, here is a calmer finish.";
    client.sendTextTurn("Tell me a short story.");
    markVoiceResponseCreated(client, "voice-three-clauses");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: assistantText }));
    const [first] = speechPlanRequests(sent);
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-three-clauses", status: "completed" } }));
    completeSpeechPlan(client, first);
    const plans = speechPlanRequests(sent);
    expect(plans).toHaveLength(2);
    expect(JSON.stringify(plans[1].response)).toContain("Last, here is a calmer finish.");
    expect(client.responseActive).toBe(false);
    expect(client.outputMeterActive).toBe(true);
  });

  it("emits a valid cue as soon as a complete JSON object arrives", () => {
    const { client, sent, cues, diagnostics } = createTextClient();
    client.sendTextTurn("I finally got the job!");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    const id = "reaction-early";
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id, metadata: request.response.metadata },
    }));
    client.handleMessage(JSON.stringify({
      type: "response.output_text.delta",
      response_id: id,
      delta: JSON.stringify({
        expression: "proud",
        intensity: 0.9,
        effect: "confetti",
        confidence: 0.95,
        anchor: "got the job",
      }),
    }));

    expect(cues).toHaveLength(1);
    expect(diagnostics.at(-1)).toMatchObject({ state: "received", turnId: request.response.metadata.turn_id });
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id, status: "completed" } }));
    expect(cues).toHaveLength(1);
  });

  it("drops a late cue after the audible response has ended", () => {
    const { client, sent, cues } = createTextClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));

    completeReaction(client, request);

    expect(cues).toEqual([]);
  });

  it("ignores a reaction from an older turn while a newer turn is active", () => {
    const { client, sent, cues } = createTextClient();
    client.sendTextTurn("I've got the job I really wanted!");
    const firstRequest = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.sendTextTurn("Actually, I didn't get it after all.");

    completeReaction(client, firstRequest, "reaction-old");

    expect(cues).toEqual([]);
  });

  it("fails soft when analysis times out while voice remains active", () => {
    const { client, sent, cues, errors } = createTextClient();
    client.sendTextTurn("Tell me something interesting.");
    markVoiceResponseCreated(client);
    advance(3500);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ expression: "neutral", effect: "none", intensity: 0, confidence: 0 });
    expect(client.responseActive).toBe(true);
    expect(errors).toEqual([]);
  });

  it("fails soft on an analysis response error without ending voice", () => {
    const { client, sent, cues, errors } = createTextClient();
    client.sendTextTurn("Tell me something interesting.");
    const request = reactionRequest(sent);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({
      type: "response.created",
      response: { id: "reaction-error", metadata: request.response.metadata },
    }));
    client.handleMessage(JSON.stringify({
      type: "response.done",
      response: { id: "reaction-error", status: "failed" },
    }));

    expect(cues).toMatchObject([{ expression: "neutral", effect: "none", confidence: 0 }]);
    expect(client.responseActive).toBe(true);
    expect(errors).toEqual([]);
  });

  it("does not reveal transcript text while output is silent, then flushes once on stop", () => {
    const { client, transcripts } = createTextClient();
    markVoiceResponseCreated(client);
    client.outputLevel = 0;
    client.outputPlaybackEnded = false;
    client.transcriptBuffer = "Hello world";
    client.startTranscriptPlayback();
    expect(transcripts).toEqual([]);

    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    expect(transcripts).toEqual(["Hello "]);

    client.outputLevel = 0;
    advance(500);
    expect(transcripts).toEqual(["Hello "]);

    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    expect(transcripts).toEqual(["Hello ", "world"]);
    vi.runOnlyPendingTimers();
    expect(transcripts).toEqual(["Hello ", "world"]);
  });

  it("starts a plan after the first complete thought instead of waiting for two sentences", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("I had a rough day.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "That sounds really rough. " }));
    expect(speechPlanRequests(sent)).toHaveLength(1);
  });

  it("never routes a retired out-of-band response into the voice lifecycle", () => {
    const { client, phases, transcripts } = createTextClient();
    markVoiceResponseCreated(client);
    const previousPhases = [...phases];
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "retired-plan", metadata: { kind: "speech_plan", request_id: "old-request" } } }));
    client.handleMessage(JSON.stringify({ type: "response.output_text.delta", response_id: "retired-plan", delta: "{}" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "retired-plan", status: "completed" } }));
    expect(client.responseActive).toBe(true);
    expect(phases).toEqual(previousPhases);
    expect(transcripts).toEqual([]);
  });

  it("responds to committed normal audio without waiting for auxiliary ASR", () => {
    const { client, sent, cues } = createTextClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "normal-input" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "normal-input", transcript: "I finally got the job!" }));
    const reaction = reactionRequest(sent);
    completeReaction(client, reaction);
    expect(cues).toHaveLength(1);
    expect(sent.filter((event) => event.type === "response.create" && !event.response)).toHaveLength(1);
  });

  it("does not deadlock a retained overlap when its auxiliary transcription fails", () => {
    const { client, sent } = createBusyClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "failed-input" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    client.handleMessage(JSON.stringify({ type: "response.done" }));
    // An overlapped committed turn gets a short ASR grace window. A failed
    // auxiliary transcript releases it immediately, without inventing a
    // reaction or waiting for the full missing-ASR fallback.
    expect(sent).toEqual([]);
    client.handleMessage(JSON.stringify({ type: "conversation.item.input_audio_transcription.failed", item_id: "failed-input", error: { message: "No transcription" } }));
    expect(sent).toEqual([{ type: "response.create" }]);
  });

  it("bounds a failed-ASR overlap, clears the matching old reply, and starts one latest reply", () => {
    const { client, sent, cues } = createTextClient();
    client.sendTextTurn("Give me an opening answer.");
    markVoiceResponseCreated(client, "voice-old");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-old" }));

    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "failed-overlap" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "failed-overlap" }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed-overlap",
      error: { message: "No transcription" },
    }));

    // Failed auxiliary ASR gives turn-taking a committed-audio signal, but it
    // must not produce a guessed director reaction. The old answer can finish
    // only through the bounded safety handoff, then its matching clear releases
    // exactly one queued response.
    advance(1_200);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(180);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-old" },
    ]);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([
      { type: "output_audio_buffer.clear" },
    ]);
    expect(cues).toEqual([]);

    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old" }));
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(2);
    expect(cues).toEqual([]);
  });

  it("bounds a committed overlap when auxiliary ASR never completes", () => {
    const { client, sent, cues } = createTextClient();
    client.sendTextTurn("Give me an opening answer.");
    markVoiceResponseCreated(client, "voice-old-no-asr");
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started", response_id: "voice-old-no-asr" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "never-transcribed" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "never-transcribed" }));

    // No delta, completed, or failed ASR event arrives. The VAD stop still
    // commits the audio, so the unknown branch must schedule its finite 4.2 s
    // fallback rather than leaving the queued turn paused forever.
    advance(4_200);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(180);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-old-no-asr" },
    ]);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([
      { type: "output_audio_buffer.clear" },
    ]);
    expect(cues).toEqual([]);

    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-old-no-asr", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared", response_id: "voice-old-no-asr" }));
    expect(sent.filter((event) => event.type === "response.create" && event.response === undefined)).toHaveLength(2);
  });

  it("hands a substantive new topic off promptly when generation has no audio yet", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("Start the old answer.");
    markVoiceResponseCreated(client, "voice-thinking");
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "new-topic" }));
    advance(500);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "new-topic",
      delta: "Actually, tell me about the weather",
    }));

    // There is no audible word to cut through, so the controller should use
    // its short overlap floor rather than the 1.2 s safety wall.
    advance(139);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([]);
    advance(1);
    expect(sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "voice-thinking" },
    ]);
    expect(sent.filter((event) => event.type === "output_audio_buffer.clear")).toEqual([]);
  });

  it("does not apply an earlier audio item's late ASR to the current user turn", () => {
    const { client, sent } = createTextClient();
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "old-input" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "new-input" }));
    client.handleMessage(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "new-input", delta: "Actually, " }));
    client.handleMessage(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "old-input", transcript: "Yeah." }));
    expect(client.userTranscript).toBe("Actually, ");
    expect(reactionRequests(sent)).toEqual([]);
  });

  it("still plans a final clause after an earlier plan times out after generation.done", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("Tell me a tiny story.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "First, a curious start. Then, a surprise arrives. Finally, a soft landing." }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-1", status: "completed" } }));
    expect(speechPlanRequests(sent)).toHaveLength(1);
    advance(3500);
    expect(speechPlanRequests(sent)).toHaveLength(2);
    expect(JSON.stringify(speechPlanRequests(sent)[1])).toContain("Finally, a soft landing.");
  });

  it("uses the heard old reply, not its unheard tail, in a deferred correction reaction", () => {
    const { client, sent } = createTextClient();
    client.sendTextTurn("I got the job.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "You got it! This part has not been heard." }));
    client.presentedAssistantTranscript = "You got it!";
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "correction" }));
    advance(500);
    client.handleMessage(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "correction", transcript: "Actually, it was a rejection." }));
    client.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client.checkTalkOver("sentence");
    advance(140);
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-1", status: "cancelled" } }));
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.cleared" }));
    const reaction = reactionRequests(sent).at(-1);
    const input = JSON.stringify((reaction?.response as { input: unknown }).input);
    expect(input).toContain("You got it!");
    expect(input).toContain("Actually, it was a rejection.");
    expect(input).not.toContain("This part has not been heard");
  });

  it("emits acting word ticks only during audible playback, not the final silent flush", () => {
    const { client, words } = createTextClient();
    markVoiceResponseCreated(client);
    client.transcriptBuffer = "Hello world";
    client.startTranscriptPlayback();
    expect(words).toEqual([]);
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    expect(words).toMatchObject([{ word: "Hello", wordTick: 1 }]);
    client.outputLevel = 0;
    advance(500);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    expect(words).toHaveLength(1);
  });

  it("uses reported audio duration to pace a fully generated reply within playback", () => {
    const { client, words } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "One two three four five six." }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-1", status: "completed", usage: { output_token_details: { audio_tokens: 20 } } } }));
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    advance(1000);
    expect(words.map((word) => word.word)).toEqual(["One", "two", "three", "four", "five", "six."]);
  });

  it("does not add word delays for a quiet phoneme after playback has started", () => {
    const { client, words } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Keep the words moving together." }));
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    advance(250);
    client.outputLevel = 0;
    advance(48);
    client.outputLevel = 0.1;
    advance(502);
    const reference = new SpeechTimeline();
    reference.updateText("Keep the words moving together.", true);
    expect(words.map((word) => word.word)).toEqual(reference.advance(800).map((word) => word.text));
  });

  it("keeps your side together through the final playback frame", () => {
    const { client, words, transcripts, captionPlans } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "What's going on on your side?" }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "voice-1", status: "completed", usage: { output_token_details: { audio_tokens: 53 } } } }));
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    advance(2650);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    const plan = captionPlans.at(-1)!;
    expect(captionWindow(transcripts.join(""), { plannedText: plan.text, breakBeforeWords: plan.breaks }).text).toBe("What's going on on your side?");
    expect(words.map((word) => word.word)).toEqual(["What's", "going", "on", "on", "your", "side?"]);
  });

  it("does not dump an unpresented paragraph or fire acting beats when output stops", () => {
    const { client, words, transcripts } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "The current thought is here. This entire later thought has not reached any of its playback deadlines yet." }));
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    advance(50);
    const actingCount = words.length;
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    expect(transcripts.join("")).not.toContain("later thought");
    expect(words).toHaveLength(actingCount);
    advance(5000);
    expect(transcripts.join("")).not.toContain("later thought");
  });

  it("accepts model caption lines before its expression JSON finishes streaming", () => {
    const { client, sent, captionPlans, cues } = createTextClient();
    client.sendTextTurn("Let's give it a try.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "We can try, then see what happens." }));
    const request = speechPlanRequests(sent)[0];
    const metadata = (request.response as { metadata: unknown }).metadata;
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "caption-director", metadata } }));
    client.handleMessage(JSON.stringify({ type: "response.output_text.delta", response_id: "caption-director", delta: '{"captions":["We can try,","then see what happens."],"cues":[' }));
    expect(captionPlans.at(-1)?.breaks).toEqual([0, 3]);
    expect(cues).toEqual([]);
  });

  it.each(["text", "function"] as const)("acts a complete streamed %s cue without waiting for the whole plan or replaying it", (transport) => {
    const { client, sent, cues, captionPlans } = createTextClient();
    const source = "That sounds really rough. How are you feeling now?";
    client.sendTextTurn("I had a hard day.");
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: source }));
    const request = speechPlanRequests(sent)[0];
    expect(request.response).toMatchObject({ conversation: "none", tool_choice: { type: "function", name: "render_speech_performance" } });
    const metadata = (request.response as { metadata: unknown }).metadata;
    const first = { kind: "speech", phraseIndex: 0, expression: "concerned", intensity: 0.8,
      effect: "none", confidence: 0.9, gesture: "tilt-left", accent: "soften", anchor: "That sounds really" };
    const second = { ...first, phraseIndex: 1, expression: "curious", gesture: "lean-in", accent: "widen", anchor: "How are you" };
    const prefix = `>{"captions":["That sounds really rough.","How are you feeling now?"],"cues":[${JSON.stringify(first)},`;
    const deltaType = transport === "text" ? "response.output_text.delta" : "response.function_call_arguments.delta";
    client.handleMessage(JSON.stringify({ type: "response.created", response: { id: "incremental-director", metadata } }));
    client.handleMessage(JSON.stringify({ type: deltaType, response_id: "incremental-director", delta: prefix }));
    expect(captionPlans.at(-1)?.breaks).toEqual([0, 4]);
    expect(cues).toEqual([]);

    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    expect(cues).toMatchObject([{ expression: "concerned", anchor: "That sounds really" }]);
    const suffix = `${JSON.stringify(second)}]}`;
    client.handleMessage(JSON.stringify({ type: deltaType, response_id: "incremental-director", delta: suffix }));
    client.handleMessage(JSON.stringify(transport === "text"
      ? { type: "response.output_text.done", response_id: "incremental-director", text: prefix + suffix }
      : { type: "response.function_call_arguments.done", response_id: "incremental-director", arguments: prefix + suffix }));
    client.handleMessage(JSON.stringify({ type: "response.done", response: { id: "incremental-director", status: "completed" } }));
    expect(cues).toHaveLength(1);
    const reference = new SpeechTimeline();
    reference.updateText(source, true);
    advance(reference.words.find((word) => word.text === "How")!.startMs);
    expect(cues.map((cue) => cue.expression)).toEqual(["concerned", "curious"]);
  });

  it("uses the rendered device timestamp, with latency-aware fallback, for the shared clock", () => {
    const { client } = createTextClient();
    client.outputFirstAudibleAt = 0;
    client.outputFirstAudioContextTime = 10;
    client.outputContext = {
      currentTime: 10.5,
      baseLatency: 0.02,
      outputLatency: 0.06,
      getOutputTimestamp: () => ({ contextTime: 10.4, performanceTime: 0 }),
    } as AudioContext;
    expect(client.playbackElapsedMs()).toBeCloseTo(400);

    client.outputContext = {
      currentTime: 10.5,
      baseLatency: 0.02,
      outputLatency: 0.06,
    } as AudioContext;
    expect(client.playbackElapsedMs()).toBeCloseTo(420);
    client.outputFirstAudioContextTime = 11;
    expect(client.playbackElapsedMs()).toBe(0);
  });

  it("keeps caption and acting indices identical when punctuation is cleaned up", () => {
    const { client, words, transcripts } = createTextClient();
    const source = "Wait — that worked–really well. Nice!Really nice.";
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: source }));
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    advance(10_000);
    expect(words.map((word) => word.word)).toEqual(captionWords(source));
    expect(words.at(-1)?.wordTick).toBe(captionWords(source).length);
    expect(transcripts.join("")).toBe(source);
  });

  it("holds captions when the audio device clock pauses instead of following wall time", () => {
    const { client, words } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Keep these words with the actual audio." }));
    let renderedTime = 10;
    client.outputContext = {
      currentTime: 10,
      state: "suspended",
      getOutputTimestamp: () => ({ contextTime: renderedTime, performanceTime: clock }),
    } as AudioContext;
    client.outputLevel = 0.1;
    client.startTranscriptPlayback();
    expect(words.map((word) => word.word)).toEqual(["Keep"]);

    advance(3000);
    expect(words.map((word) => word.word)).toEqual(["Keep"]);
    renderedTime += 0.7;
    advance(16);
    expect(words.length).toBeGreaterThan(1);
  });

  it("keeps the last caption active until measured local output has drained", () => {
    const { client, phases } = createTextClient();
    markVoiceResponseCreated(client);
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.started" }));
    client.outputContext = { state: "running" } as AudioContext;
    client.outputWasAudible = true;
    client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));

    advance(160);
    expect(client.outputPlaybackEnded).toBe(false);
    expect(phases.at(-1)).toBe("speaking");
    client.outputQuietSince = clock;
    advance(119);
    expect(client.outputPlaybackEnded).toBe(false);
    advance(25);
    expect(client.outputPlaybackEnded).toBe(true);
    expect(client.outputMeterActive).toBe(false);
    expect(phases.at(-1)).toBe("listening");
  });

  it("bounds the drain wait if the meter fails and cancels it when End is pressed", () => {
    const first = createTextClient();
    markVoiceResponseCreated(first.client);
    first.client.outputContext = { state: "running" } as AudioContext;
    first.client.outputWasAudible = true;
    first.client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    advance(720);
    expect(first.client.outputPlaybackEnded).toBe(true);

    const second = createTextClient();
    markVoiceResponseCreated(second.client);
    second.client.outputContext = { state: "running" } as AudioContext;
    second.client.outputWasAudible = true;
    second.client.handleMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }));
    advance(60);
    second.client.close();
    const phaseCount = second.phases.length;
    expect(second.phases.at(-1)).toBe("idle");
    advance(1000);
    expect(second.phases).toHaveLength(phaseCount);
  });
});
