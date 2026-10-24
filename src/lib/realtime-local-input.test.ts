import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient } from "./realtime";

type WireEvent = Record<string, unknown>;

type InternalLocalClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  processLocalInput: (rms: number, now: number) => void;
  beginUserInput: (itemId: string | null) => void;
  handleMessage: (raw: string) => void;
  close: (resetPhase?: boolean) => void;
  manualTurnDetection: boolean;
  responseActive: boolean;
  outputMeterActive: boolean;
  activeVoiceResponseId: string | null;
  activeInputItemId: string | null;
  inputAudioCommitted: boolean;
  inputTranscriptComplete: boolean;
  inputWasBackchannel: boolean;
  queuedUserTurn: boolean;
  userSpeechActive: boolean;
  userTranscript: string;
};

describe("Realtime client-owned input turns", () => {
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
    const phases: string[] = [];
    const userTranscriptDeltas: string[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: (delta) => userTranscriptDeltas.push(delta),
      onAmplitude: () => undefined,
      onError: () => undefined,
    });
    const client = voice as unknown as InternalLocalClient;
    client.channel = {
      readyState: "open",
      send: (raw) => sent.push(JSON.parse(raw) as WireEvent),
      close: () => undefined,
    };
    // /api/config advertises the client-owned VAD mode in production. Set the
    // private flag directly here so these tests exercise the audio path without
    // opening a WebRTC session or making a network request.
    client.manualTurnDetection = true;
    return { client, sent, phases, userTranscriptDeltas };
  }

  function at(client: InternalLocalClient, rms: number, now: number): void {
    clock = now;
    vi.setSystemTime(now);
    client.processLocalInput(rms, now);
  }

  function advance(ms: number): void {
    clock += ms;
    vi.setSystemTime(clock);
    vi.advanceTimersByTime(ms);
  }

  /** Drive one ordinary utterance through the detector's attack and release. */
  function driveSpeech(client: InternalLocalClient, startAt = 0): void {
    at(client, 0, startAt);
    for (let now = startAt + 16; now <= startAt + 160; now += 16) {
      at(client, 0.03, now);
    }
    for (let now = startAt + 176; now <= startAt + 900; now += 16) {
      at(client, 0, now);
    }
  }

  function events(sent: WireEvent[], type: string): WireEvent[] {
    return sent.filter((event) => event.type === type);
  }

  function voiceResponses(sent: WireEvent[]): WireEvent[] {
    return sent.filter((event) => event.type === "response.create" && event.response === undefined);
  }

  it("commits a standalone utterance and waits for the committed item before responding", () => {
    const { client, sent } = createClient();

    driveSpeech(client);

    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);
    expect(voiceResponses(sent)).toHaveLength(0);
    expect(events(sent, "response.cancel")).toEqual([]);
    expect(events(sent, "output_audio_buffer.clear")).toEqual([]);

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "local-item-1",
    }));

    expect(client.activeInputItemId).toBe("local-item-1");
    expect(client.inputAudioCommitted).toBe(true);
    expect(voiceResponses(sent)).toHaveLength(1);
  });

  it("does not commit on a brief 250 ms pause, then commits after a real 420 ms quiet release", () => {
    const { client, sent } = createClient();

    at(client, 0, 0);
    for (let now = 16; now <= 160; now += 16) at(client, 0.03, now);
    for (let now = 176; now <= 400; now += 16) at(client, 0, now);

    // A short pause inside one thought must not send a premature commit.
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(0);

    // Resume the same utterance, then end it with the app-level 420 ms
    // release window. The pure detector default remains 580 ms for callers
    // that need the more conservative behavior.
    for (let now = 416; now <= 432; now += 16) at(client, 0.03, now);
    for (let now = 448; now <= 896; now += 16) at(client, 0, now);

    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);
    expect(events(sent, "response.cancel")).toEqual([]);
    expect(events(sent, "output_audio_buffer.clear")).toEqual([]);
  });

  it("holds an overlapped brief backchannel until ASR classifies it, without touching old audio", () => {
    const { client, sent } = createClient();
    client.responseActive = true;
    client.outputMeterActive = true;
    client.activeVoiceResponseId = "voice-old";

    driveSpeech(client);

    // Local speech onset and stop only affect the input buffer. They must not
    // cancel or clear the currently playing response.
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);
    expect(events(sent, "response.cancel")).toEqual([]);
    expect(events(sent, "output_audio_buffer.clear")).toEqual([]);

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "backchannel-item",
    }));
    expect(voiceResponses(sent)).toHaveLength(0);

    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "backchannel-item",
      transcript: "yeah",
    }));

    expect(client.inputWasBackchannel).toBe(true);
    expect(client.queuedUserTurn).toBe(false);
    expect(voiceResponses(sent)).toHaveLength(0);
    expect(events(sent, "response.cancel")).toEqual([]);
    expect(events(sent, "output_audio_buffer.clear")).toEqual([]);

    // A completed backchannel must not wake a latent grace timer later.
    advance(1_000);
    expect(voiceResponses(sent)).toHaveLength(0);
    expect(client.outputMeterActive).toBe(true);
  });

  it("maps FIFO commit acknowledgements and ignores stale ASR after a newer local turn", () => {
    const { client, sent, userTranscriptDeltas } = createClient();

    driveSpeech(client, 0);
    // The second utterance begins before the first commit acknowledgement, so
    // the server's first item must be recorded but must not become active.
    driveSpeech(client, 1_000);
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(2);

    // The old item's completed transcript can beat both commit ACKs. It is
    // buffered, then discarded when its ACK is associated with the stale
    // generation rather than being applied to the newer turn.
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "older-item",
      transcript: "stale old topic",
    }));
    expect(client.userTranscript).toBe("");

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "older-item",
    }));
    expect(client.activeInputItemId).not.toBe("older-item");
    expect(voiceResponses(sent)).toHaveLength(0);

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "newer-item",
    }));
    expect(client.activeInputItemId).toBe("newer-item");
    expect(voiceResponses(sent)).toHaveLength(1);

    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "newer-item",
      transcript: "new topic",
    }));
    const deltasBeforeStale = [...userTranscriptDeltas];

    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "older-item",
      transcript: "stale old topic",
    }));

    expect(client.userTranscript).toBe("new topic");
    expect(userTranscriptDeltas).toEqual(deltasBeforeStale);
    expect(voiceResponses(sent)).toHaveLength(1);
  });

  it("replays delta and completion that arrive before the commit ACK without delaying response.create", () => {
    const { client, sent, userTranscriptDeltas } = createClient();

    driveSpeech(client);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "early-item",
      delta: "I finally ",
    }));
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "early-item",
      transcript: "I finally got the job!",
    }));

    expect(client.userTranscript).toBe("");
    expect(voiceResponses(sent)).toHaveLength(0);

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "early-item",
    }));

    // The audio response starts as soon as the commit is acknowledged; the
    // buffered ASR is replayed afterward to refine local context and cues.
    expect(voiceResponses(sent)).toHaveLength(1);
    expect(client.userTranscript).toBe("I finally got the job!");
    expect(userTranscriptDeltas).toEqual(["I finally ", "got the job!"]);
  });

  it("replays an early failed ASR event without inventing text or deadlocking the voice response", () => {
    const { client, sent } = createClient();

    driveSpeech(client);
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed-early-item",
      error: { message: "No transcription" },
    }));
    expect(client.inputTranscriptComplete).toBe(false);

    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "failed-early-item",
    }));

    expect(voiceResponses(sent)).toHaveLength(1);
    expect(client.inputTranscriptComplete).toBe(true);
    expect(client.inputWasBackchannel).toBe(false);
    expect(client.userTranscript).toBe("");
  });

  it("retains final ASR even when its pre-ack delta queue reached the bound", () => {
    const { client, sent } = createClient();
    driveSpeech(client);
    for (let index = 0; index < 40; index += 1) {
      client.handleMessage(JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "many-deltas",
        delta: "partial ",
      }));
    }
    client.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "many-deltas",
      transcript: "I finally got the job.",
    }));
    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "many-deltas",
    }));
    expect(client.inputTranscriptComplete).toBe(true);
    expect(client.userTranscript).toBe("I finally got the job.");
    expect(voiceResponses(sent)).toHaveLength(1);
  });

  it("releases a missing-ASR overlap after the bounded 850 ms grace once old generation has drained", () => {
    const { client, sent } = createClient();
    client.responseActive = true;
    client.outputMeterActive = true;
    client.activeVoiceResponseId = "voice-old";

    driveSpeech(client);

    // The old response has finished/drained by the time the commit ack arrives,
    // but the input was still an overlap and must get its short ASR window.
    client.responseActive = false;
    client.outputMeterActive = false;
    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "unknown-item",
    }));

    expect(voiceResponses(sent)).toHaveLength(0);
    advance(849);
    expect(voiceResponses(sent)).toHaveLength(0);
    advance(1);
    expect(voiceResponses(sent)).toHaveLength(1);
  });

  it("resets local detection on close and ignores late acknowledgements or samples", () => {
    const { client, sent, phases } = createClient();

    driveSpeech(client);
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);
    const sentBeforeClose = sent.length;

    client.close();
    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "late-item",
    }));
    advance(1_000);
    at(client, 0.03, 2_000);

    expect(sent).toHaveLength(sentBeforeClose);
    expect(client.userSpeechActive).toBe(false);
    expect(client.queuedUserTurn).toBe(false);
    expect(client.activeInputItemId).toBeNull();
    expect(phases.at(-1)).toBe("idle");
  });

  it("does not split a continuous utterance after thirty seconds, then commits once after real quiet", () => {
    const { client, sent } = createClient();

    // The client-owned detector deliberately has no hard utterance cap. A
    // long, continuously voiced thought must remain one input buffer; only a
    // sustained quiet interval can produce the commit.
    at(client, 0, 0);
    for (let now = 16; now <= 30_000; now += 16) at(client, 0.03, now);
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(0);

    // A brief dip is not enough to end the turn. Continue with actual quiet
    // until the detector's release window has elapsed.
    for (let now = 30_016; now <= 30_700; now += 16) at(client, 0, now);
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);

    // The voice response remains gated on the provider's committed-item ack.
    expect(voiceResponses(sent)).toHaveLength(0);
  });

  it("fails closed when a manual commit acknowledgement is lost, and ignores a late ack", () => {
    const errors: string[] = [];
    const sent: WireEvent[] = [];
    const phases: string[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onError: (message) => errors.push(message),
    });
    const client = voice as unknown as InternalLocalClient;
    client.channel = {
      readyState: "open",
      send: (raw) => sent.push(JSON.parse(raw) as WireEvent),
      close: () => undefined,
    };
    client.manualTurnDetection = true;

    driveSpeech(client);
    expect(events(sent, "input_audio_buffer.commit")).toHaveLength(1);
    expect(voiceResponses(sent)).toHaveLength(0);

    // The watchdog is intentionally bounded: an absent committed ack must
    // not leave the UI paused forever waiting for a response that can never
    // be associated with the local item.
    advance(3_499);
    expect(errors).toEqual([]);
    expect(phases).not.toContain("error");
    advance(1);
    expect(errors).toEqual(["Your last voice turn wasn't received. Please start the conversation again."]);
    expect(phases.at(-1)).toBe("error");

    const sentBeforeLateAck = sent.length;
    client.handleMessage(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "late-after-watchdog",
    }));
    advance(1_000);

    // A late server event cannot resurrect the closed turn or create an
    // unprompted response after the explicit error.
    expect(sent).toHaveLength(sentBeforeLateAck);
    expect(voiceResponses(sent)).toHaveLength(0);
  });
});
