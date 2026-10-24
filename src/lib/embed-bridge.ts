import type {
  RealtimeTransport,
  RealtimeVoiceConfig,
  VoiceGrounding,
  VoiceGroundingRequest,
} from "./realtime";

export const SHERPA_EMBED_PROTOCOL = 1;
const DEFAULT_PARENT_ORIGIN = "http://127.0.0.1:4103";
const RPC_TIMEOUT_MS = 20_000;

type RuntimeConfig = {
  hosted?: boolean;
  parentOrigins?: string[];
  qa?: boolean;
};

export type SherpaVoiceQaSnapshot = {
  ready: boolean;
  turnComplete: boolean;
  phase: string;
  transcript: string;
  sources: unknown[];
  error: string | null;
  outputPeak: number;
  heardUser: string;
};

export type SherpaVoiceQaHandle = {
  readonly ready: boolean;
  readonly turnComplete: boolean;
  sendTextTurn: (text: string) => boolean;
  sendAudioTurn: (encoded: string) => Promise<boolean>;
  snapshot: () => SherpaVoiceQaSnapshot;
};

type RpcRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type RpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

type ConnectMessage = {
  type?: string;
  protocol?: number;
};

declare global {
  interface Window {
    __MOOD_VOICE_EMBED_CONFIG__?: RuntimeConfig;
    __sherpaVoiceQa?: SherpaVoiceQaHandle;
  }
}

function configuredParentOrigins(): string[] {
  const runtimeConfig = window.__MOOD_VOICE_EMBED_CONFIG__;
  const configured = runtimeConfig?.parentOrigins ?? [];
  const hosted = runtimeConfig?.hosted === true;
  // The parent allowlist comes from the server response. A URL parameter is
  // intentionally never allowed to authorize an arbitrary embedding site.
  const candidates = configured.length > 0 ? configured : [DEFAULT_PARENT_ORIGIN];
  return candidates.flatMap((candidate) => {
    try {
      const url = new URL(candidate);
      const loopback = (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
        && (url.protocol === "http:" || url.protocol === "https:");
      const exactOrigin = url.origin === candidate.replace(/\/$/u, "") && !url.pathname.replace(/\/$/u, "") && !url.search && !url.hash;
      const secureHosted = hosted && url.protocol === "https:";
      return (loopback || secureHosted) && exactOrigin ? [url.origin] : [];
    } catch {
      return [];
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortError(): DOMException {
  return new DOMException("The voice bridge request was cancelled.", "AbortError");
}

export class SherpaEmbedBridge implements RealtimeTransport {
  private port: MessagePort | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private ready = false;
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timeout: number;
  }>();
  private readonly parentOrigins = configuredParentOrigins();
  private readonly onWindowMessage = (event: MessageEvent<unknown>) => {
    if (this.disposed || event.source !== window.parent || !this.parentOrigins.includes(event.origin)) return;
    if (!isRecord(event.data)) return;
    const message = event.data as ConnectMessage;
    if (message.type === "epitome:voice-stop") {
      this.onStop?.();
      return;
    }
    if (message.type !== "epitome:voice-connect" || message.protocol !== SHERPA_EMBED_PROTOCOL) return;
    const port = event.ports[0];
    if (!port || this.ready) return;
    this.port = port;
    this.ready = true;
    port.addEventListener("message", this.onPortMessage);
    port.addEventListener("messageerror", this.onPortError);
    port.start();
    this.resolveReady();
  };
  private readonly onPortMessage = (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && event.data.type === "epitome:voice-stop") {
      this.onStop?.();
      return;
    }
    if (!isRecord(event.data) || typeof event.data.id !== "string") return;
    const response = event.data as RpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    window.clearTimeout(pending.timeout);
    if (typeof response.error === "string" && response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  };
  private readonly onPortError = () => {
    const error = new Error("The SHERPA voice bridge closed unexpectedly.");
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.ready = false;
    this.port = null;
  };
  private onStop: (() => void) | null = null;

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    window.addEventListener("message", this.onWindowMessage);
    this.announceReady();
  }

  setStopHandler(handler: (() => void) | null): void {
    this.onStop = handler;
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) return;
    if (!this.parentOrigins.length) throw new Error("No trusted SHERPA parent origin is configured.");
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      this.readyPromise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
    });
  }

  async getConfig(signal: AbortSignal): Promise<RealtimeVoiceConfig> {
    return this.call<RealtimeVoiceConfig>("config", {}, signal);
  }

  async createSession(sdp: string, signal: AbortSignal): Promise<string> {
    const result = await this.call<{ sdp?: string }>("session", { sdp }, signal);
    if (!result || typeof result.sdp !== "string" || !result.sdp.startsWith("v=0")) {
      throw new Error("The SHERPA voice session returned an invalid answer.");
    }
    return result.sdp;
  }

  async search(request: VoiceGroundingRequest): Promise<VoiceGrounding | null> {
    return this.call<VoiceGrounding | null>("search", {
      question: request.question,
      ...(request.previousQuestion ? { previous_question: request.previousQuestion } : {}),
    }, request.signal);
  }

  async openSource(id: string, excerpt?: string): Promise<void> {
    await this.call("open-source", { id, ...(excerpt ? { excerpt } : {}) });
  }

  async closeRemote(): Promise<void> {
    if (!this.ready) return;
    await this.call("close", {});
  }

  call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.disposed || !this.port || !this.ready) return Promise.reject(new Error("The SHERPA voice bridge is not connected."));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = `voice-rpc-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The SHERPA voice request timed out."));
      }, RPC_TIMEOUT_MS);
      const onAbort = () => {
        window.clearTimeout(timeout);
        this.pending.delete(id);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timeout,
      });
      const message: RpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
      this.port?.postMessage(message);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("message", this.onWindowMessage);
    this.port?.removeEventListener("message", this.onPortMessage);
    this.port?.removeEventListener("messageerror", this.onPortError);
    this.port?.close();
    this.port = null;
    const error = new Error("The SHERPA voice bridge was closed.");
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectReady(error);
  }

  private announceReady(): void {
    const message = { type: "mood-voice:ready", protocol: SHERPA_EMBED_PROTOCOL };
    for (const origin of this.parentOrigins) window.parent.postMessage(message, origin);
    if (!this.ready && !this.disposed) window.setTimeout(() => this.announceReady(), 350);
  }
}
