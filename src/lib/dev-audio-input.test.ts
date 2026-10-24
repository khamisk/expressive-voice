import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevAudioInput } from "./dev-audio-input";

type FakeTrack = {
  kind: "audio";
  stop: ReturnType<typeof vi.fn>;
};

type FakeStream = {
  getTracks: ReturnType<typeof vi.fn>;
  getAudioTracks: ReturnType<typeof vi.fn>;
};

type FakeDestination = {
  stream: FakeStream;
};

type FakeNode = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type FakeSilenceSource = FakeNode & {
  offset: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly state: AudioContextState = "running";
  readonly destination = {} as AudioDestinationNode;
  readonly close = vi.fn().mockResolvedValue(undefined);
  readonly createMediaStreamDestination = vi.fn();
  readonly createGain = vi.fn();
  readonly createConstantSource = vi.fn();
  readonly destinationNode: FakeDestination;
  readonly track: FakeTrack;
  readonly gain: FakeNode & { gain: { value: number } };
  readonly silenceSource: FakeSilenceSource;

  constructor() {
    const track: FakeTrack = { kind: "audio", stop: vi.fn() };
    this.track = track;
    const stream: FakeStream = {
      getTracks: vi.fn(() => [track]),
      getAudioTracks: vi.fn(() => [track]),
    };
    this.destinationNode = { stream };
    this.gain = {
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    this.silenceSource = {
      offset: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.createMediaStreamDestination.mockReturnValue(this.destinationNode);
    this.createGain.mockReturnValue(this.gain);
    this.createConstantSource.mockReturnValue(this.silenceSource);
    FakeAudioContext.instances.push(this);
  }
}

describe("DevAudioInput keepalive lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    FakeAudioContext.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates one zero keepalive source connected only to the media destination", () => {
    const input = new DevAudioInput();

    const firstStream = input.stream();
    const secondStream = input.stream();
    const context = FakeAudioContext.instances[0];

    expect(secondStream).toBe(firstStream);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
    expect(context.createConstantSource).toHaveBeenCalledTimes(1);
    expect(context.silenceSource.offset.value).toBe(0);
    expect(context.silenceSource.connect).toHaveBeenCalledTimes(1);
    expect(context.silenceSource.connect).toHaveBeenCalledWith(context.destinationNode);
    expect(context.silenceSource.connect).not.toHaveBeenCalledWith(context.destination);
    expect(context.silenceSource.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the silent source and live track when fixture playback is stopped", () => {
    const input = new DevAudioInput();
    const stream = input.stream();
    const context = FakeAudioContext.instances[0];
    const track = context.track;

    input.stop();

    expect(input.stream()).toBe(stream);
    expect(context.createConstantSource).toHaveBeenCalledTimes(1);
    expect(context.silenceSource.stop).not.toHaveBeenCalled();
    expect(context.silenceSource.disconnect).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("stops and disconnects the keepalive, track, and context exactly once on close", () => {
    const input = new DevAudioInput();
    const stream = input.stream();
    const context = FakeAudioContext.instances[0];
    const track = context.track;

    input.close();
    input.close();

    expect(context.silenceSource.stop).toHaveBeenCalledTimes(1);
    expect(context.silenceSource.disconnect).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(() => input.stream()).toThrow("closed");
  });
});
