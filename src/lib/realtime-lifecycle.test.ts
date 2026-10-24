import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient } from "./realtime";
import type { ConversationPhase } from "../types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAudioElement(): HTMLAudioElement {
  return {
    autoplay: false,
    muted: false,
    volume: 1,
    paused: true,
    srcObject: null,
    style: { display: "" },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLAudioElement;
}

class FakeAudioContext {
  state: AudioContextState = "running";
  sampleRate = 48_000;
  destination = {} as AudioDestinationNode;
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);

  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    };
  }

  createBuffer() {
    return {};
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: vi.fn(),
    };
  }

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = "closed";
    this.emit("close", {});
  });
  private readonly listeners = new Map<string, (event: unknown) => void>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, event: unknown): void {
    this.listeners.get(type)?.(event);
  }
}

let offerFactory: () => Promise<RTCSessionDescriptionInit> = async () => ({
  type: "offer",
  sdp: "fake-offer",
});

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = [];

  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  readonly createDataChannel = vi.fn(() => this.channel);
  readonly createOffer = vi.fn(() => offerFactory());
  readonly setLocalDescription = vi.fn().mockResolvedValue(undefined);
  readonly setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });
  connectionState: RTCPeerConnectionState = "new";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }
}

function createStream() {
  const tracks = [{
    kind: "audio",
    stop: vi.fn(),
  }] as unknown as MediaStreamTrack[];
  const stream = {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks),
  } as unknown as MediaStream;
  return { stream, tracks };
}

type InternalClient = {
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  localStream: MediaStream | null;
};

describe("Realtime connection lifecycle cancellation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => createAudioElement()),
      body: { appendChild: vi.fn() },
    });

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ready: true }),
      text: vi.fn().mockResolvedValue("fake-answer"),
    });
    vi.stubGlobal("fetch", fetchMock);

    getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    FakePeerConnection.instances.length = 0;
    offerFactory = async () => ({ type: "offer", sdp: "fake-offer" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createClient() {
    const phases: ConversationPhase[] = [];
    const errors: string[] = [];
    const voice = new RealtimeVoiceClient({
      onPhase: (phase) => phases.push(phase),
      onTranscriptReset: () => undefined,
      onTranscriptDelta: () => undefined,
      onUserTranscriptReset: () => undefined,
      onUserTranscriptDelta: () => undefined,
      onAmplitude: () => undefined,
      onError: (message) => errors.push(message),
    });
    return { voice, phases, errors };
  }

  it("stops a microphone stream that resolves after the client was closed", async () => {
    const media = deferred<MediaStream>();
    const { stream, tracks } = createStream();
    getUserMedia.mockReturnValue(media.promise);
    const { voice, phases, errors } = createClient();

    const connectPromise = voice.connect();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    voice.close();
    expect(phases).toEqual(["connecting", "idle"]);

    media.resolve(stream);
    await expect(connectPromise).resolves.toBeUndefined();

    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect((voice as unknown as InternalClient).peer).toBeNull();
    expect((voice as unknown as InternalClient).localStream).toBeNull();
    expect(phases).toEqual(["connecting", "idle"]);
    expect(errors).toEqual([]);
  });

  it("does not resurrect a closed client when offer negotiation resolves late", async () => {
    const { stream, tracks } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const offer = deferred<RTCSessionDescriptionInit>();
    offerFactory = () => offer.promise;
    const { voice, phases, errors } = createClient();

    const connectPromise = voice.connect();
    await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
    const peer = FakePeerConnection.instances[0];
    const channel = peer.channel;
    await vi.waitFor(() => expect(peer.createOffer).toHaveBeenCalledTimes(1));

    voice.close();
    expect(phases).toEqual(["connecting", "idle"]);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);

    offer.resolve({ type: "offer", sdp: "late-offer" });
    await expect(connectPromise).resolves.toBeUndefined();

    // A stale open/state callback must not bring the UI back to listening or
    // invoke an initial text turn after End/unmount.
    channel.emit("open", {});
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();

    expect(channel.send).not.toHaveBeenCalled();
    expect(phases).toEqual(["connecting", "idle"]);
    expect(errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((voice as unknown as InternalClient).peer).toBeNull();
    expect((voice as unknown as InternalClient).channel).toBeNull();
    expect((voice as unknown as InternalClient).localStream).toBeNull();
  });

  it("attaches the supplied QA audio track without opening a microphone and releases it on close", async () => {
    const { stream, tracks } = createStream();
    const { voice, errors } = createClient();
    await voice.connect({ inputStream: stream });
    const peer = FakePeerConnection.instances[0];
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer.addTrack).toHaveBeenCalledWith(tracks[0], stream);
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "fake-answer" });
    voice.close();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("releases the microphone and contexts when the data channel closes unexpectedly", async () => {
    const { stream, tracks } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const { voice, phases, errors } = createClient();
    await voice.connect();
    const peer = FakePeerConnection.instances[0];
    peer.channel.emit("close", {});
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect((voice as unknown as InternalClient).localStream).toBeNull();
    expect(phases.at(-1)).toBe("error");
    expect(errors.at(-1)).toContain("connection closed");
  });

  it.each([
    ["NotAllowedError", /microphone access is blocked.*allow/iu],
    ["PermissionDeniedError", /microphone access is blocked.*allow/iu],
    ["NotFoundError", /no microphone.*connect/iu],
    ["DevicesNotFoundError", /no microphone.*connect/iu],
    ["NotReadableError", /microphone.*another app/iu],
    ["TrackStartError", /microphone.*another app/iu],
    ["SecurityError", /microphone.*security settings/iu],
  ])("explains %s before attempting a provider voice session", async (name, expected) => {
    const denied = new Error("Permission denied");
    denied.name = name as string;
    getUserMedia.mockRejectedValue(denied);
    const { voice, phases, errors } = createClient();

    await expect(voice.connect()).rejects.toBe(denied);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(expected as RegExp);
    expect(phases).toEqual(["connecting", "error"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Local config only, no provider request.
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect((voice as unknown as InternalClient).localStream).toBeNull();
  });

  it("preserves an actionable API credit error and closes the failed startup", async () => {
    const { stream, tracks } = createStream();
    const message = "OpenAI API credits have run out. Add credits in API billing, then start again.";
    getUserMedia.mockResolvedValue(stream);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true }) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({
      error: message, code: "credit_balance_exhausted", retryable: false,
    }) });
    const { voice, phases, errors } = createClient();

    await expect(voice.connect()).rejects.toThrow(message);

    expect(errors).toEqual([message]);
    expect(phases.at(-1)).toBe("error");
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledTimes(1);
    expect((voice as unknown as InternalClient).peer).toBeNull();
    expect((voice as unknown as InternalClient).localStream).toBeNull();
  });

  it("does not display a malformed non-text session error as an object", async () => {
    const { stream } = createStream();
    getUserMedia.mockResolvedValue(stream);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true }) });
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => '{"error":{"internal":"detail"}}' });
    const { voice, errors } = createClient();

    await expect(voice.connect()).rejects.toThrow("The voice service could not start.");
    expect(errors[0]).not.toContain("[object Object]");
  });
});
