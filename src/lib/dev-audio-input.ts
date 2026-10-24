/**
 * A bounded, browser-only audio source for end-to-end Realtime QA.
 *
 * The source keeps one live MediaStream track for the lifetime of the helper.
 * Fixture audio is connected to a MediaStreamDestination only while a fixture
 * is playing, so the WebRTC sender receives silence between fixtures. Nothing
 * is connected to AudioContext.destination: these recordings are test input,
 * not local playback.
 */

export type DevAudioInputPhase = "idle" | "loading" | "playing" | "error";

export type DevAudioInputState = {
  phase: DevAudioInputPhase;
  url: string | null;
  progress: number;
  elapsedSeconds: number;
  durationSeconds: number | null;
  error: string | null;
};

export type DevAudioInputPlayback = {
  status: "completed" | "cancelled";
  url: string;
  durationSeconds: number;
  elapsedSeconds: number;
};

export type DevAudioInputOptions = {
  /** Called for lifecycle/progress changes. Values describe the fixture only. */
  onState?: (state: DevAudioInputState) => void;
  /** Keep fixture requests same-origin so a QA action cannot fetch an arbitrary URL. */
  allowCrossOrigin?: boolean;
};

type ActivePlayback = {
  token: number;
  url: string;
  source: AudioBufferSourceNode;
  startedAt: number;
  durationSeconds: number;
  resolve: (result: DevAudioInputPlayback) => void;
};

const initialState: DevAudioInputState = {
  phase: "idle",
  url: null,
  progress: 0,
  elapsedSeconds: 0,
  durationSeconds: null,
  error: null,
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("Audio fixture playback was cancelled.", "AbortError");
}

/**
 * Plays a public WAV/decoded audio fixture into a WebRTC-ready stream.
 *
 * Use `stream()` as the input passed to RTCPeerConnection.addTrack(). Call
 * `playFixture()` from a user gesture while the AudioContext may be suspended.
 * Calling playFixture again cancels the current fixture and starts the new one
 * without replacing the stream track.
 */
export class DevAudioInput {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private gain: GainNode | null = null;
  private silenceSource: ConstantSourceNode | null = null;
  private active: ActivePlayback | null = null;
  private requestController: AbortController | null = null;
  private progressTimer: number | null = null;
  private token = 0;
  private closed = false;
  private state: DevAudioInputState = { ...initialState };

  constructor(private readonly options: DevAudioInputOptions = {}) {}

  /** Returns the stable MediaStream to attach to RTCPeerConnection. */
  stream(): MediaStream {
    this.ensureOpen();
    this.ensureGraph();
    return this.destination!.stream;
  }

  /** Current state is a snapshot and can be used to initialize UI. */
  getState(): DevAudioInputState {
    return { ...this.state };
  }

  /**
   * Fetch, decode, and play one same-origin fixture into the input stream.
   * Cancellation is a resolved `{status: "cancelled"}` result so a Stop or a
   * rapid replay does not create an unhandled promise rejection in dev UI.
   */
  async playFixture(relativeURL: string): Promise<DevAudioInputPlayback> {
    this.ensureOpen();
    const url = this.resolveFixtureURL(relativeURL);
    this.stop();
    const token = ++this.token;
    const controller = new AbortController();
    this.requestController = controller;
    this.publish({
      phase: "loading",
      url,
      progress: 0,
      elapsedSeconds: 0,
      durationSeconds: null,
      error: null,
    });

    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load the voice input fixture (${response.status}).`);

      const total = Number(response.headers.get("content-length")) || 0;
      const bytes = await this.readResponse(response, total, token);
      if (token !== this.token || this.closed) return this.cancelledResult(url);

      const context = this.ensureGraph().context;
      if (context.state === "suspended") await context.resume();
      if (token !== this.token || this.closed) return this.cancelledResult(url);
      const buffer = await context.decodeAudioData(bytes.slice(0));
      if (token !== this.token || this.closed) return this.cancelledResult(url);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      const durationSeconds = buffer.duration;
      const startedAt = context.currentTime;

      return await new Promise<DevAudioInputPlayback>((resolve) => {
        const active: ActivePlayback = {
          token,
          url,
          source,
          startedAt,
          durationSeconds,
          resolve,
        };
        this.active = active;
        source.addEventListener(
          "ended",
          () => {
            if (this.active !== active || token !== this.token || this.closed) return;
            this.clearProgressTimer();
            this.active = null;
            this.requestController = null;
            this.publish({
              phase: "idle",
              url,
              progress: 1,
              elapsedSeconds: durationSeconds,
              durationSeconds,
              error: null,
            });
            resolve({ status: "completed", url, durationSeconds, elapsedSeconds: durationSeconds });
          },
          { once: true },
        );
        source.start();
        this.publish({
          phase: "playing",
          url,
          progress: 0,
          elapsedSeconds: 0,
          durationSeconds,
          error: null,
        });
        this.startProgressTimer(active);
      });
    } catch (error) {
      if (isAbortError(error) || token !== this.token || this.closed) return this.cancelledResult(url);
      this.requestController = null;
      const message = error instanceof Error ? error.message : "Could not play the voice input fixture.";
      this.publish({
        phase: "error",
        url,
        progress: 0,
        elapsedSeconds: 0,
        durationSeconds: null,
        error: message,
      });
      throw new Error(message);
    }
  }

  /** Stop current fetch/playback while leaving a silent live stream available. */
  stop(): void {
    this.token += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.clearProgressTimer();

    const active = this.active;
    this.active = null;
    if (active) {
      try {
        active.source.stop();
      } catch {
        // An already-ended source is harmless to stop.
      }
      active.source.disconnect();
      active.resolve({
        status: "cancelled",
        url: active.url,
        durationSeconds: active.durationSeconds,
        elapsedSeconds: Math.max(0, (this.context?.currentTime ?? active.startedAt) - active.startedAt),
      });
    }

    if (!this.closed) {
      this.publish({
        phase: "idle",
        url: active?.url ?? this.state.url,
        progress: active ? Math.min(1, this.state.progress) : this.state.progress,
        elapsedSeconds: active ? this.state.elapsedSeconds : this.state.elapsedSeconds,
        durationSeconds: active?.durationSeconds ?? this.state.durationSeconds,
        error: null,
      });
    }
  }

  /** Stop playback and release the WebRTC track/AudioContext. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.silenceSource?.stop();
    this.silenceSource?.disconnect();
    this.silenceSource = null;
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.destination = null;
    this.gain = null;
    const context = this.context;
    this.context = null;
    if (context) void context.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The dev audio input has been closed.");
  }

  private ensureGraph(): { context: AudioContext; destination: MediaStreamAudioDestinationNode } {
    if (!this.context || !this.destination || !this.gain) {
      const AudioContextClass = window.AudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support AudioContext input fixtures.");
      this.context = new AudioContextClass();
      this.destination = this.context.createMediaStreamDestination();
      this.gain = this.context.createGain();
      this.gain.gain.value = 1;
      // Deliberately do not connect to context.destination: no local speaker output.
      this.gain.connect(this.destination);
      // Keep samples flowing after a fixture ends. A live track alone does
      // not guarantee silent RTP frames when its last source has stopped;
      // without trailing silence the remote VAD can wait forever for turn end.
      this.silenceSource = this.context.createConstantSource();
      this.silenceSource.offset.value = 0;
      this.silenceSource.connect(this.destination);
      this.silenceSource.start();
    }
    return { context: this.context, destination: this.destination };
  }

  private resolveFixtureURL(relativeURL: string): string {
    const value = relativeURL.trim();
    if (!value) throw new Error("A voice input fixture URL is required.");
    let url: URL;
    try {
      url = new URL(value, document.baseURI);
    } catch {
      throw new Error("The voice input fixture URL is invalid.");
    }
    if (!this.options.allowCrossOrigin && url.origin !== window.location.origin) {
      throw new Error("Voice input fixtures must be same-origin.");
    }
    return url.href;
  }

  private async readResponse(response: Response, total: number, token: number): Promise<ArrayBuffer> {
    if (!response.body) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) {
        chunks.push(result.value);
        received += result.value.byteLength;
        if (token === this.token && !this.closed) {
          this.publish({ ...this.state, progress: total > 0 ? Math.min(0.8, (received / total) * 0.8) : 0.2 });
        }
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  private startProgressTimer(active: ActivePlayback): void {
    this.clearProgressTimer();
    const tick = () => {
      if (this.active !== active || this.closed) return;
      const elapsedSeconds = Math.max(0, Math.min(active.durationSeconds, this.context!.currentTime - active.startedAt));
      this.publish({
        phase: "playing",
        url: active.url,
        progress: active.durationSeconds > 0 ? elapsedSeconds / active.durationSeconds : 1,
        elapsedSeconds,
        durationSeconds: active.durationSeconds,
        error: null,
      });
      this.progressTimer = window.setTimeout(tick, 50);
    };
    this.progressTimer = window.setTimeout(tick, 50);
  }

  private clearProgressTimer(): void {
    if (this.progressTimer !== null) {
      window.clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private cancelledResult(url: string): DevAudioInputPlayback {
    return {
      status: "cancelled",
      url,
      durationSeconds: this.state.durationSeconds ?? 0,
      elapsedSeconds: this.state.elapsedSeconds,
    };
  }

  private publish(next: DevAudioInputState): void {
    this.state = { ...next, progress: Math.max(0, Math.min(1, next.progress)) };
    this.options.onState?.(this.getState());
  }
}

export function createDevAudioInput(options?: DevAudioInputOptions): DevAudioInput {
  return new DevAudioInput(options);
}
