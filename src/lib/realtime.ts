import { completedTranscript, inputTranscriptDelta, realtimeErrorMessage, transcriptDelta } from "./realtime-events";
import type { RealtimeServerEvent } from "./realtime-events";
import {
  buildReactionAnalysisInput,
  buildSpeechPlanInput,
  REACTION_ANALYZER_INSTRUCTIONS,
  SPEECH_PLAN_ANALYZER_INSTRUCTIONS,
  REACTION_TOOL,
  SPEECH_PLAN_TOOL,
  parseReactionCue,
  parseReactionPlan,
  parseStreamingReactionPlan,
  parseCaptionBreaks,
  type ReactionContextTurn,
  type ReactionCue,
} from "./reaction-cues";
import { missingTranscriptSuffix, OutputTranscriptStream } from "./transcript-stream";
import type { ConversationPhase } from "../types";
import { startFrameLoop } from "./frame-loop";
import { HeardDelay, VoiceBeatDetector, outputDelayMs, type VoiceBeatState } from "./voice-beats";
import { CaptionPlanner, captionWords, speechPunctuation, type CaptionPlan, type PlaybackWord } from "./spoken-caption";
import { TalkOverController, isBackchannel, type TalkOverBoundary } from "./turn-taking";
import { SpeechTimeline, ACTING_LEAD_MS } from "./caption-clock";
import { completeJsonObject } from "./director-json";
import { LocalTurnDetector } from "./local-turn-detector";
import { deriveFastSpeechCue, deriveImmediateUserCue } from "./phrase-cues";
import { speechBeatSpans } from "./speech-beat-spans";
import { CHARACTER_TOOL_NAME, parseCharacterPerformance } from "./embodied-character";
import { characterContext, VoiceCharacterPerformance, type CharacterDisplayState } from "./voice-character";
import { DEFAULT_GROUNDING_FAILURE, buildConversationInstructions, buildGroundingInstructions } from "./grounding";

type MeterSource = "input" | "output";

export type ReactionDiagnostic = {
  state: "requested" | "prepared" | "received" | "timeout" | "failed" | "rejected";
  turnId: string;
  elapsedMs?: number;
  reason?: string;
};

export type TransportDiagnostic = {
  atMs: number;
  direction: "send" | "receive" | "local";
  type: string;
  responseId?: string;
  itemId?: string;
  turnDetection?: "client" | "provider";
  characterToolAvailable?: boolean;
  responseStatus?: string;
  responseReason?: string;
  outputKinds?: string[];
  generating: boolean;
  playing: boolean;
  userSpeaking: boolean;
};

export type VoiceSource = {
  id: string;
  title?: string;
  excerpt?: string;
};

export type VoiceGrounding = {
  context: string;
  sources?: VoiceSource[];
  mode?: "documents" | "conversation";
};

export type VoiceGroundingRequest = {
  question: string;
  previousQuestion?: string;
  signal: AbortSignal;
};

export type VoiceGroundingProvider = (
  request: VoiceGroundingRequest,
) => Promise<VoiceGrounding | null>;

export type RealtimeVoiceConfig = {
  ready?: boolean;
  turnDetection?: string;
  characterControl?: string;
};

export type RealtimeTransport = {
  getConfig: (signal: AbortSignal) => Promise<RealtimeVoiceConfig>;
  createSession: (sdp: string, signal: AbortSignal) => Promise<string>;
};

export type RealtimeCallbacks = {
  getCharacterState?: () => CharacterDisplayState | null;
  onPhase: (phase: ConversationPhase) => void;
  onTranscriptReset: () => void;
  onTranscriptDelta: (delta: string) => void;
  onUserTranscriptReset: () => void;
  onUserTranscriptDelta: (delta: string) => void;
  onAmplitude: (source: MeterSource, amplitude: number) => void;
  /** Syllable beats found in the voice audio, released when they are heard. */
  onVoiceBeat?: (beat: VoiceBeatState) => void;
  onPlaybackWord?: (word: PlaybackWord) => void;
  onCaptionPlan?: (plan: CaptionPlan) => void;
  onHandoff?: (reason: string) => void;
  onReactionCue?: (cue: ReactionCue) => void;
  onReactionDiagnostic?: (event: ReactionDiagnostic) => void;
  onSessionInstructions?: (instructions: string) => void;
  onTransportDiagnostic?: (event: TransportDiagnostic) => void;
  onGrounding?: (grounding: VoiceGrounding | null) => void;
  onError: (message: string) => void;
};

type WireOutputItem = {
  type?: string;
  status?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string; transcript?: string }>;
};

type WireResponse = {
  id?: string;
  status?: string;
  status_details?: { reason?: string; error?: { message?: string } };
  metadata?: Record<string, unknown>;
  usage?: { output_token_details?: { audio_tokens?: number } };
  output?: WireOutputItem[];
};

type WireEvent = {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  name?: string;
  call_id?: string;
  item?: WireOutputItem;
  transcript?: string;
  item_id?: string;
  event_id?: string;
  response_id?: string;
  error?: { message?: string; event_id?: string };
  response?: WireResponse;
  session?: { instructions?: string; tools?: Array<{ name?: string }>; audio?: { input?: { turn_detection?: unknown } } };
};

type ReactionRequest = {
  requestId: string;
  kind: "reaction" | "speech_plan";
  turnId: string;
  userText: string;
  assistantText: string;
  responseId: string | null;
  responseText: string;
  startedAt: number;
  timeoutId: number | null;
  timedOut: boolean;
  completed: boolean;
  emitted: boolean;
  rejectionReported: boolean;
  planParsed: boolean;
  receivedReported: boolean;
  preparedCue?: ReactionCue;
  captionsParsed?: boolean;
  parsedCueCount?: number;
  pendingCues: ReactionCue[];
  plannedFrom: number;
  plannedThrough: number;
};

const REACTION_RESPONSE_KIND = "reaction_cue";
const SPEECH_PLAN_RESPONSE_KIND = "speech_plan";
// Leave enough room for a short out-of-band JSON response to finish while the
// voice is already starting. It is still bounded and never gates response.create.
const REACTION_TIMEOUT_MS = 3500;
const SPEECH_PLAN_TIMEOUT_MS = 3500;
const MAX_CONTEXT_TURNS = 8;
const MAX_CONTEXT_CHARS = 3200;
const MAX_REACTION_REQUESTS = 8;
const MAX_SPEECH_PLAN_CUES = 6;
const SPEECH_PLAN_MAX_OUTPUT_TOKENS = 800;
const MIN_PLAN_TEXT_LENGTH = 14;
const OUTPUT_AUDIBLE_THRESHOLD = 0.018;
const OVERLAP_TRANSCRIPT_GRACE_MS = 850;
const IDLE_INPUT_CLEAR_MS = 1_500;
const GROUNDING_TIMEOUT_MS = 2_750;
const MAX_GROUNDING_CONTEXT_CHARS = 12_000;

type GroundingState = {
  generation: number;
  turnId: string;
  controller: AbortController;
  promise: Promise<void>;
  instructions: string | null;
};

type RealtimeVoiceClientOptions = {
  transport?: RealtimeTransport;
  grounding?: VoiceGroundingProvider;
  reactions?: boolean;
};

export class RealtimeVoiceClient {
  private closed = false;
  private connectionEpoch = 0;
  private connectionAbort: AbortController | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private microphoneMuted = false;
  private audioElement: HTMLAudioElement | null = null;
  private contexts: AudioContext[] = [];
  private outputContext: AudioContext | null = null;
  private outputGain: GainNode | null = null;
  private meterCleanups: Array<() => void> = [];
  private responseHasAudio = false;
  private sawOutputBufferEvents = false;
  private outputMeterActive = false;
  private outputSilenceTimer: number | null = null;
  private transcriptPlaybackTimer: number | null = null;
  private transcriptBuffer = "";
  private generatedTranscript = "";
  private readonly outputTranscriptStream = new OutputTranscriptStream();
  private userTranscript = "";
  private transcriptCanPlay = false;
  private outputPlaybackEnded = false;
  private outputTemporarilyCleared = false;
  private responseInterrupted = false;
  private playbackPhaseTimer: number | null = null;
  private playbackWarningTimer: number | null = null;
  private bargeInTimer: number | null = null;
  private handoffTimer: number | null = null;
  private handoffPending = false;
  private fadeCleanup: (() => void) | null = null;
  private talkOver = new TalkOverController();
  private inputLevel = 0;
  private inputTranscriptComplete = false;
  private inputAudioCommitted = false;
  private inputTranscriptionFailed = false;
  private activeInputItemId: string | null = null;
  private inputTurnOverlapped = false;
  private inputWasBackchannel = false;
  private inputCommittedAt: number | null = null;
  private inputStartedAt: number | null = null;
  private inputHeldFloor = false;
  private overlapTranscriptTimer: number | null = null;
  private manualTurnDetection = false;
  private nativeCharacterEnabled = false;
  private voiceCharacter = new VoiceCharacterPerformance();
  private nativeToolCalls = new Set<string>();
  private nativeToolResponseIds = new Set<string>();
  private nativeSilent = false;
  private nativeContinuationUsed = false;
  private pendingNativeContinuation = false;
  private takingFloorContextPending = false;
  private characterContextItemId: string | null = null;
  private characterContextSequence = 0;
  private voiceResponseRequestSequence = 0;
  private voiceResponseRequestId: string | null = null;
  private awaitingVoiceResponse = false;
  // A long real utterance must end on its actual pause, not lose everything
  // after an arbitrary 25-second local detector boundary.
  private localTurnDetector = new LocalTurnDetector({ maxUtteranceMs: null, releaseMs: 420 });
  private manualInputGeneration = 0;
  private pendingManualCommits: Array<{ generation: number; eventId: string; sentAt: number }> = [];
  /**
   * ASR can be delivered before the server acknowledges the manual commit.
   * Keep those item-keyed events out of the active turn until the ACK gives us
   * the generation fence; replaying them once then preserves late context
   * without letting an older item overwrite a newer local utterance.
   */
  private pendingManualTranscriptions = new Map<string, WireEvent[]>();
  private manualCommitTimer: number | null = null;
  private manualInputItems = new Map<string, number>();
  private lastInputBufferClearAt = 0;
  private outputQuietSince: number | null = null;
  private outputWasAudible = false;
  private outputFirstAudibleAt: number | null = null;
  private estimatedOutputDurationMs: number | null = null;
  private outputFirstAudioContextTime: number | null = null;
  private outputDrainTimer: number | null = null;
  // A clear acknowledgement belongs to the response that was faded out. Do
  // not let a late/duplicate clear release a newer response, and do not leave
  // the next user turn waiting forever if the provider drops the ack.
  private outputClearPending = false;
  private outputClearTimer: number | null = null;
  private pendingOutputClearResponseId: string | null = null;
  private timeline = new SpeechTimeline();
  private captionPlanner = new CaptionPlanner();
  private captionPlan: CaptionPlan = { text: "", breaks: [0] };
  private authoredCaptionBreaks = new Set<number>();
  private pendingOutputBoundary: { at: number; boundary: TalkOverBoundary } | null = null;
  private playbackWordTick = 0;
  private playbackPhraseTick = 0;
  private previousWordEndedPhrase = false;
  private userSpeechActive = false;
  private queuedUserTurn = false;
  private responseActive = false;
  private outputLevel = 0;
  private transcriptWaitingForAudio = false;
  private sessionGeneration = 0;
  private turnSequence = 0;
  private reactionRequestSequence = 0;
  private latestReactionTurnId: string | null = null;
  private eligibleUserReactionTurnId: string | null = null;
  private pendingUserTurnId: string | null = null;
  private finalizedUserTurn = false;
  private finalizedUserText = "";
  private recentContext: ReactionContextTurn[] = [];
  private reactionRequests = new Map<string, ReactionRequest>();
  private reactionResponses = new Map<string, ReactionRequest>();
  private retiredAnalysisResponses = new Set<string>();
  private reactionEventRequests = new Map<string, ReactionRequest>();
  private pendingSpeechCues: ReactionCue[] = [];
  private fastSpeechCues = new Map<number, { cue: ReactionCue; end: number; emitted: boolean }>();
  private authoredSpeechStarts = new Set<number>();
  private lateContextRefinedStarts = new Set<number>();
  private voiceUserText = "";
  private presentedAssistantTranscript = "";
  private speechPlanCoveredChars = 0;
  private speechPlanRequestedThrough = 0;
  private speechPlanRequestActive = false;
  private speechPlanRequestId: string | null = null;
  private emittedSpeechTurns = new Set<string>();
  private assistantTranscriptComplete = false;
  private activeVoiceTurnId: string | null = null;
  private activeVoiceResponseId: string | null = null;
  private readonly retiredVoiceResponseIds = new Set<string>();
  private voiceResponseEnded = false;
  private assistantContextRecorded = false;
  private assistantContextEntry: ReactionContextTurn | null = null;
  private readonly transport?: RealtimeTransport;
  private readonly grounding?: VoiceGroundingProvider;
  private readonly reactionsEnabled: boolean;
  private groundingState: GroundingState | null = null;
  private activeGroundingInstructions: string | null = null;

  constructor(private callbacks: RealtimeCallbacks, options: RealtimeVoiceClientOptions = {}) {
    this.transport = options.transport;
    this.grounding = options.grounding;
    this.reactionsEnabled = options.reactions !== false;
  }

  async connect(options: { syntheticInput?: boolean; inputStream?: MediaStream; initialText?: string } = {}): Promise<void> {
    if (this.connectionAbort || this.peer || this.localStream) this.close(false);
    const epoch = ++this.connectionEpoch;
    const controller = new AbortController();
    this.connectionAbort = controller;
    this.closed = false;
    const isCurrent = () => !this.closed && this.connectionEpoch === epoch;
    this.startSessionGeneration();
    this.callbacks.onPhase("connecting");
    this.primeAudioOutput();

    try {
      const config = this.transport
        ? await this.transport.getConfig(controller.signal)
        : await (async () => {
          const configResponse = await fetch("/api/config", { cache: "no-store", signal: controller.signal });
          return (await configResponse.json()) as RealtimeVoiceConfig;
        })();
      if (!isCurrent()) return;
      if (!isCurrent()) return;
      if (!config.ready) {
        throw new Error("Add a fresh OpenAI API key to .env.local, then restart the app.");
      }
      this.manualTurnDetection = config.turnDetection === "client";
      this.nativeCharacterEnabled = config.characterControl === "voice";

      const localStream = options.inputStream ?? (options.syntheticInput
        ? this.createSyntheticInput()
        : await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }));

      // Permission can resolve after navigation or End. A late microphone
      // stream is not owned by close(), so stop it before returning.
      if (!isCurrent()) {
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.localStream = localStream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.audioElement = document.createElement("audio");
      this.audioElement.autoplay = false;
      this.audioElement.setAttribute("playsinline", "");
      this.audioElement.muted = false;
      this.audioElement.volume = 1;
      this.audioElement.setAttribute("aria-hidden", "true");
      this.audioElement.style.display = "none";
      document.body.appendChild(this.audioElement);

      peer.ontrack = (event) => {
        if (!isCurrent()) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (!this.audioElement) return;
        this.audioElement.srcObject = stream;
        const play = () => {
          if (isCurrent()) void this.playRemoteAudio();
        };
        this.audioElement.addEventListener("loadedmetadata", play, { once: true });
        this.audioElement.addEventListener("canplay", play, { once: true });
        event.track.addEventListener("unmute", play, { once: true });
        const outputContext = this.outputContext;
        if (outputContext) {
          this.startMeter(stream, "output", outputContext, true);
          void outputContext
            .resume()
            .then(() => {
              if (!isCurrent() || !this.audioElement) return;
              if (outputContext.state === "running") {
                this.audioElement.muted = true;
                this.audioElement.pause();
              } else {
                this.audioElement.muted = false;
                play();
              }
            })
            .catch(() => {
              if (!isCurrent()) return;
              if (this.audioElement) this.audioElement.muted = false;
              play();
            });
        } else {
          play();
          this.startMeter(stream, "output");
        }
      };

      peer.onconnectionstatechange = () => {
        if (!isCurrent()) return;
        const state = peer.connectionState;
        if (state === "failed" || state === "disconnected") {
          this.fail("The live voice connection was lost. Start again when you're ready.");
        }
      };

      for (const track of localStream.getAudioTracks()) {
        peer.addTrack(track, localStream);
      }
      this.startMeter(localStream, "input");

      this.channel = peer.createDataChannel("oai-events");
      this.channel.addEventListener("open", () => {
        if (!isCurrent()) return;
        this.localTurnDetector.reset(this.now(), true);
        this.lastInputBufferClearAt = this.now();
        this.callbacks.onPhase("listening");
        if (!options.initialText) return;
        this.sendTextTurn(options.initialText);
      });
      this.channel.addEventListener("message", (message) => {
        if (isCurrent()) this.handleMessage(message.data);
      });
      this.channel.addEventListener("close", () => {
        if (isCurrent()) this.fail("The live voice connection closed. Start again when you're ready.");
      });

      const offer = await peer.createOffer();
      if (!isCurrent()) return;
      await peer.setLocalDescription(offer);
      if (!isCurrent()) return;

      const body = this.transport
        ? await this.transport.createSession(offer.sdp ?? "", controller.signal)
        : await (async () => {
          const response = await fetch("/api/realtime/session", {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: offer.sdp,
            signal: controller.signal,
          });

          if (!isCurrent()) return "";
          const responseBody = await response.text();
          if (!isCurrent()) return "";
          if (!response.ok) {
            let message = "The voice service could not start. Please try again.";
            try {
              const failure = JSON.parse(responseBody) as { error?: unknown };
              if (typeof failure?.error === "string" && failure.error.trim()) message = failure.error;
            } catch {
              // The service can return plain text for transport errors.
            }
            throw new Error(message);
          }
          return responseBody;
        })();

      if (!isCurrent()) return;

      await peer.setRemoteDescription({ type: "answer", sdp: body });
    } catch (error) {
      if (!isCurrent()) return;
      this.close(false);
      const microphoneErrors: Record<string, string> = {
        NotAllowedError: "Microphone access is blocked. Allow the microphone for this site, then start again.",
        PermissionDeniedError: "Microphone access is blocked. Allow the microphone for this site, then start again.",
        NotFoundError: "No microphone was found. Connect a microphone, then start again.",
        DevicesNotFoundError: "No microphone was found. Connect a microphone, then start again.",
        NotReadableError: "The microphone could not be opened. Check whether another app is using it, then try again.",
        TrackStartError: "The microphone could not be opened. Check whether another app is using it, then try again.",
        SecurityError: "Microphone access is disabled by browser security settings. Allow access for this site.",
      };
      const message = error instanceof Error
        ? microphoneErrors[error.name] ?? error.message
        : "The voice service could not start.";
      this.callbacks.onError(message);
      this.callbacks.onPhase("error");
      throw error;
    }
  }

  /**
   * Sends a text turn through the real Realtime connection. This is useful
   * for local QA/dev tooling and deliberately uses the same conversation,
   * response, and reaction path as microphone input.
   */
  sendTextTurn(text: string): void {
    const normalized = text.trim();
    if (this.closed || !normalized || this.channel?.readyState !== "open") return;

    const overlapped = this.responseActive || this.outputMeterActive || this.handoffPending;
    if (overlapped) this.beginUserInput(null);

    this.userSpeechActive = false;
    this.clearBargeInTimer();
    this.inputTranscriptComplete = true;
    this.inputAudioCommitted = overlapped;
    this.inputTranscriptionFailed = false;
    this.inputTurnOverlapped = overlapped;
    this.inputWasBackchannel = false;
    this.clearOverlapTranscriptTimer();
    this.inputCommittedAt = null;
    this.manualInputGeneration += 1;
    this.activeInputItemId = null;
    this.finalizedUserTurn = false;
    this.finalizedUserText = "";
    if (!overlapped) {
      this.pendingUserTurnId = null;
      this.callbacks.onUserTranscriptReset();
    }
    this.callbacks.onUserTranscriptDelta(normalized);
    this.userTranscript = normalized;
    this.inputWasBackchannel = overlapped && isBackchannel(normalized);
    if (this.inputWasBackchannel) {
      this.pendingUserTurnId = null;
      this.finalizedUserTurn = true;
      this.finalizedUserText = normalized;
    } else this.finalizeUserTurn(normalized);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.queuedUserTurn = !this.inputWasBackchannel;
    if (overlapped) this.checkTalkOver();
    this.requestQueuedResponse();
  }

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  isMicrophoneMuted(): boolean {
    return this.microphoneMuted;
  }

  close(resetPhase = true): void {
    this.closed = true;
    this.connectionEpoch += 1;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    this.invalidateReactionState();
    this.groundingState?.controller.abort();
    this.groundingState = null;
    this.activeGroundingInstructions = null;
    this.callbacks.onGrounding?.(null);
    for (const cleanup of this.meterCleanups) cleanup();
    this.meterCleanups = [];
    for (const context of this.contexts) void context.close();
    this.contexts = [];
    this.outputContext = null;
    this.outputGain = null;
    this.fadeCleanup?.();
    this.fadeCleanup = null;
    if (this.handoffTimer !== null) window.clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
    this.handoffPending = false;
    if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
    this.outputClearTimer = null;
    this.outputClearPending = false;
    this.pendingOutputClearResponseId = null;
    this.retiredVoiceResponseIds.clear();
    this.talkOver.reset();
    this.inputLevel = 0;
    this.inputTranscriptComplete = false;
    this.inputAudioCommitted = false;
    this.inputTranscriptionFailed = false;
    this.activeInputItemId = null;
    this.inputTurnOverlapped = false;
    this.inputWasBackchannel = false;
    this.resetLocalInput();
    this.pendingOutputBoundary = null;
    this.outputQuietSince = null;
    this.outputWasAudible = false;
    this.outputFirstAudibleAt = null;
    this.estimatedOutputDurationMs = null;
    this.outputFirstAudioContextTime = null;
    if (this.outputDrainTimer !== null) window.clearTimeout(this.outputDrainTimer);
    this.outputDrainTimer = null;
    this.timeline.reset();
    this.captionPlanner.reset();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.microphoneMuted = false;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    if (this.playbackWarningTimer !== null) {
      window.clearTimeout(this.playbackWarningTimer);
      this.playbackWarningTimer = null;
    }
    if (this.playbackPhaseTimer !== null) {
      window.clearTimeout(this.playbackPhaseTimer);
      this.playbackPhaseTimer = null;
    }
    if (this.bargeInTimer !== null) {
      window.clearTimeout(this.bargeInTimer);
      this.bargeInTimer = null;
    }
    if (this.outputSilenceTimer !== null) {
      window.clearTimeout(this.outputSilenceTimer);
      this.outputSilenceTimer = null;
    }
    if (this.transcriptPlaybackTimer !== null) {
      window.clearTimeout(this.transcriptPlaybackTimer);
      this.transcriptPlaybackTimer = null;
    }
    this.transcriptBuffer = "";
    this.generatedTranscript = "";
    this.outputTranscriptStream.reset();
    this.userTranscript = "";
    this.transcriptCanPlay = false;
    this.outputPlaybackEnded = false;
    this.outputTemporarilyCleared = false;
    this.responseInterrupted = false;
    this.outputMeterActive = false;
    this.outputLevel = 0;
    this.transcriptWaitingForAudio = false;
    this.userSpeechActive = false;
    this.queuedUserTurn = false;
    this.responseActive = false;
    this.finalizedUserTurn = false;
    this.finalizedUserText = "";
    this.activeVoiceTurnId = null;
    this.activeVoiceResponseId = null;
    this.retiredVoiceResponseIds.clear();
    this.voiceResponseEnded = false;
    this.assistantContextRecorded = false;
    this.outputClearPending = false;
    this.pendingOutputClearResponseId = null;
    if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
    this.outputClearTimer = null;
    this.assistantContextEntry = null;
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    this.callbacks.onAmplitude("input", 0);
    this.callbacks.onAmplitude("output", 0);
    if (resetPhase) this.callbacks.onPhase("idle");
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.closed && this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
      const response = event.response as { metadata?: { kind?: string } } | undefined;
      if (response?.metadata?.kind !== REACTION_RESPONSE_KIND && response?.metadata?.kind !== SPEECH_PLAN_RESPONSE_KIND) {
        this.emitTransportDiagnostic("send", event as WireEvent);
      }
    }
  }

  private emitTransportDiagnostic(direction: TransportDiagnostic["direction"], event: WireEvent): void {
    if (!import.meta.env.DEV || !this.callbacks.onTransportDiagnostic || !event.type) return;
    if (!/^(input_audio_buffer\.|output_audio_buffer\.|response\.(created|done|create|cancel|function_call_arguments\.done|output_item\.done)$|session\.|local\.|error$)/u.test(event.type)) return;
    this.callbacks.onTransportDiagnostic({
      atMs: Math.round(this.now()), direction, type: event.type,
      responseId: this.responseIdForEvent(event) ?? undefined,
      itemId: event.item_id,
      ...(event.session?.audio?.input
        ? { turnDetection: event.session.audio.input.turn_detection === null ? "client" as const : "provider" as const }
        : {}),
      ...(event.session?.tools ? { characterToolAvailable: event.session.tools.some(tool => tool.name === CHARACTER_TOOL_NAME) } : {}),
      ...(event.response?.status ? { responseStatus: event.response.status } : {}),
      ...(event.response?.status_details?.reason ? { responseReason: event.response.status_details.reason } : {}),
      ...(event.response?.output ? { outputKinds: event.response.output.map(item => item.type ?? "unknown") } : {}),
      generating: this.responseActive, playing: this.outputMeterActive, userSpeaking: this.userSpeechActive,
    });
  }

  private clearOverlapTranscriptTimer(): void {
    if (this.overlapTranscriptTimer !== null) window.clearTimeout(this.overlapTranscriptTimer);
    this.overlapTranscriptTimer = null;
  }

  private resetLocalInput(): void {
    this.clearOverlapTranscriptTimer();
    this.inputCommittedAt = null;
    this.inputStartedAt = null;
    this.inputHeldFloor = false;
    this.localTurnDetector.reset();
    this.manualInputGeneration = 0;
    this.pendingManualCommits = [];
    this.pendingManualTranscriptions.clear();
    if (this.manualCommitTimer !== null) window.clearTimeout(this.manualCommitTimer);
    this.manualCommitTimer = null;
    this.manualInputItems.clear();
    this.lastInputBufferClearAt = 0;
  }

  private beginUserInput(itemId: string | null): void {
    // A new input owns its transcription immediately. An older commit/ASR
    // acknowledgement must not end or overwrite this newer local utterance.
    this.clearOverlapTranscriptTimer();
    this.inputCommittedAt = null;
    this.inputStartedAt = this.now();
    this.inputHeldFloor = false;
    this.eligibleUserReactionTurnId = null;
    this.userSpeechActive = true;
    this.queuedUserTurn = false;
    this.activeInputItemId = itemId;
    this.inputTranscriptComplete = false;
    this.inputAudioCommitted = false;
    this.inputTranscriptionFailed = false;
    this.inputWasBackchannel = false;
    this.inputTurnOverlapped = this.responseActive || this.outputMeterActive;
    if (!this.handoffPending) this.talkOver.reset();
    this.userTranscript = "";
    this.finalizedUserTurn = false;
    this.finalizedUserText = "";
    this.pendingUserTurnId = this.nextTurnId();
    this.callbacks.onUserTranscriptReset();
    if (this.inputTurnOverlapped) this.checkTalkOver();
    else this.callbacks.onPhase("listening");
  }

  private commitUserInput(): void {
    this.markInputPause();
    this.userSpeechActive = false;
    this.inputAudioCommitted = true;
    this.inputCommittedAt ??= this.now();
    if (!this.inputWasBackchannel) this.queuedUserTurn = true;
    this.checkTalkOver();
    this.requestQueuedResponse();
  }

  private markInputPause(): void {
    // Measure until the local pause, not the later network commit ACK. This
    // lets a genuinely sustained turn bypass the backchannel ASR grace.
    if (this.userSpeechActive && this.inputStartedAt !== null) {
      this.inputHeldFloor = this.now() - this.inputStartedAt >= 1_500;
    }
  }

  private bufferManualTranscription(event: WireEvent): void {
    const itemId = event.item_id;
    // Without an item id there is no safe way to associate an early event with
    // a manual commit. Likewise, do not retain an unknown late event after all
    // pending commits have been acknowledged.
    if (!itemId || this.pendingManualCommits.length === 0) return;
    const events = this.pendingManualTranscriptions.get(itemId) ?? [];
    // A bounded per-item queue is enough for delta/completed/failed. Do not let
    // malformed transport traffic accumulate across a long session.
    if (events.length >= 32) {
      // Completion/failure carries the authoritative result. Keep it even
      // when a long, rapidly streamed prefix filled the bounded delta queue.
      if (event.type?.endsWith(".delta")) return;
      events.shift();
    }
    events.push({ ...event });
    this.pendingManualTranscriptions.set(itemId, events);
    while (this.pendingManualTranscriptions.size > 16) {
      this.pendingManualTranscriptions.delete(this.pendingManualTranscriptions.keys().next().value!);
    }
  }

  private replayManualTranscriptions(itemId: string, generation: number): void {
    const events = this.pendingManualTranscriptions.get(itemId);
    if (!events) return;
    this.pendingManualTranscriptions.delete(itemId);
    if (generation !== this.manualInputGeneration) return;
    // The event is now mapped to the current generation, so the normal handler
    // can apply deltas, completion, or failure exactly once in wire order.
    for (const event of events) this.handleMessage(JSON.stringify(event));
  }

  private processLocalInput(rms: number, now: number): void {
    if (!this.manualTurnDetection || this.closed) return;
    if (this.channel?.readyState !== "open") {
      this.localTurnDetector.calibrate({ nowMs: now, rms });
      return;
    }
    const state = this.localTurnDetector.update({ nowMs: now, rms });
    if (state.started) {
      this.manualInputGeneration += 1;
      this.beginUserInput(null);
      this.emitTransportDiagnostic("local", { type: "local.speech_started" });
    }
    if (state.stopped) {
      this.markInputPause();
      this.userSpeechActive = false;
      this.emitTransportDiagnostic("local", { type: "local.speech_stopped" });
      const eventId = `input-commit-${this.sessionGeneration}-${this.manualInputGeneration}`;
      this.pendingManualCommits.push({ generation: this.manualInputGeneration, eventId, sentAt: now });
      this.lastInputBufferClearAt = now;
      // Commit the live WebRTC input, but wait for its item acknowledgement
      // before asking for a response. Never clear/cancel output on speech onset.
      this.sendEvent({ type: "input_audio_buffer.commit", event_id: eventId });
      this.watchManualCommits();
      this.checkTalkOver();
    }
    if (
      !state.active && !state.started && !state.stopped && state.speechMs === 0
      && rms < 0.004 && this.pendingManualCommits.length === 0
      && now - this.lastInputBufferClearAt >= IDLE_INPUT_CLEAR_MS
    ) {
      // Keep a bounded quiet pre-roll. Clearing at confirmed speech onset
      // would erase its first syllable, so only discard genuinely idle input.
      this.sendEvent({ type: "input_audio_buffer.clear" });
      this.lastInputBufferClearAt = now;
    }
  }

  private watchManualCommits(): void {
    if (this.manualCommitTimer !== null) window.clearTimeout(this.manualCommitTimer);
    this.manualCommitTimer = null;
    const pending = this.pendingManualCommits[0];
    if (!pending || this.closed) return;
    this.manualCommitTimer = window.setTimeout(() => {
      this.manualCommitTimer = null;
      if (this.closed || !this.pendingManualCommits.some(commit => commit.eventId === pending.eventId)) return;
      // Retrying a commit could duplicate an input item. Recover explicitly
      // instead of leaving the user in an unbounded silent listening state.
      this.fail("Your last voice turn wasn't received. Please start the conversation again.");
    }, Math.max(1, 3_500 - (this.now() - pending.sentAt)));
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private playbackElapsedMs(): number {
    if (this.outputFirstAudibleAt === null) return 0;
    const context = this.outputContext;
    if (context && this.outputFirstAudioContextTime !== null) {
      // getOutputTimestamp refers to the device-rendered clock, not merely the
      // samples queued in Web Audio. Fall back for older embedded WebViews.
      const timestamp = context.getOutputTimestamp?.();
      const outputTime = timestamp?.contextTime && timestamp.contextTime > 0
        ? timestamp.contextTime
        : context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0);
      return Math.max(0, (outputTime - this.outputFirstAudioContextTime) * 1000);
    }
    return Math.max(0, this.now() - this.outputFirstAudibleAt);
  }

  private updateCaptionPlan(): void {
    const source = this.generatedTranscript || this.presentedAssistantTranscript + this.transcriptBuffer;
    this.captionPlan = this.captionPlanner.update(source, {
      spokenWords: this.playbackWordTick,
      breakBeforeWords: [...this.authoredCaptionBreaks],
      complete: this.assistantTranscriptComplete,
    });
    this.callbacks.onCaptionPlan?.(this.captionPlan);
  }

  private emitReactionDiagnostic(event: ReactionDiagnostic): void {
    if (import.meta.env?.DEV) this.callbacks.onReactionDiagnostic?.(event);
  }

  private startSessionGeneration(): void {
    this.resetLocalInput();
    this.resetNativeCharacter();
    this.nativeCharacterEnabled = false;
    this.takingFloorContextPending = false;
    this.characterContextItemId = null;
    this.characterContextSequence = 0;
    this.voiceResponseRequestSequence = 0;
    this.voiceResponseRequestId = null;
    this.awaitingVoiceResponse = false;
    this.sessionGeneration += 1;
    this.turnSequence = 0;
    this.reactionRequestSequence = 0;
    this.latestReactionTurnId = null;
    this.eligibleUserReactionTurnId = null;
    this.pendingUserTurnId = null;
    this.finalizedUserTurn = false;
    this.finalizedUserText = "";
    this.recentContext = [];
    this.invalidateReactionRequests();
    this.retiredAnalysisResponses.clear();
    this.pendingSpeechCues = [];
    this.presentedAssistantTranscript = "";
    this.speechPlanCoveredChars = 0;
    this.speechPlanRequestedThrough = 0;
    this.speechPlanRequestActive = false;
    this.speechPlanRequestId = null;
    this.emittedSpeechTurns.clear();
    this.assistantTranscriptComplete = false;
    this.activeVoiceTurnId = null;
    this.activeVoiceResponseId = null;
    this.inputAudioCommitted = false;
    this.inputTranscriptionFailed = false;
    this.inputWasBackchannel = false;
    this.voiceResponseEnded = false;
    this.assistantContextRecorded = false;
    this.outputClearPending = false;
    this.pendingOutputClearResponseId = null;
    if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
    this.outputClearTimer = null;
    this.retiredVoiceResponseIds.clear();
  }

  private invalidateReactionState(): void {
    this.resetNativeCharacter();
    this.takingFloorContextPending = false;
    this.characterContextItemId = null;
    this.voiceResponseRequestId = null;
    this.awaitingVoiceResponse = false;
    this.sessionGeneration += 1;
    this.latestReactionTurnId = null;
    this.eligibleUserReactionTurnId = null;
    this.pendingUserTurnId = null;
    this.recentContext = [];
    this.invalidateReactionRequests();
    this.pendingSpeechCues = [];
    this.presentedAssistantTranscript = "";
    this.speechPlanCoveredChars = 0;
    this.speechPlanRequestedThrough = 0;
    this.speechPlanRequestActive = false;
    this.speechPlanRequestId = null;
    this.emittedSpeechTurns.clear();
    this.assistantTranscriptComplete = false;
    this.outputClearPending = false;
    this.pendingOutputClearResponseId = null;
    if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
    this.outputClearTimer = null;
    this.retiredVoiceResponseIds.clear();
  }

  private invalidateReactionRequests(): void {
    for (const request of this.reactionRequests.values()) {
      if (request.timeoutId !== null) window.clearTimeout(request.timeoutId);
      if (request.responseId) this.retiredAnalysisResponses.add(request.responseId);
    }
    this.reactionRequests.clear();
    this.reactionResponses.clear();
    this.reactionEventRequests.clear();
    this.pendingSpeechCues = [];
    this.speechPlanRequestActive = false;
    this.speechPlanRequestId = null;
  }

  private nextTurnId(): string {
    this.turnSequence += 1;
    return `${this.sessionGeneration}:${this.turnSequence}`;
  }

  private recordContext(role: ReactionContextTurn["role"], text: string): ReactionContextTurn | null {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    const entry = { role, text: normalized };
    this.recentContext.push(entry);
    while (this.recentContext.length > MAX_CONTEXT_TURNS) this.recentContext.shift();
    while (
      this.recentContext.reduce((total, turn) => total + turn.text.length, 0) > MAX_CONTEXT_CHARS
      && this.recentContext.length > 1
    ) {
      this.recentContext.shift();
    }
    return entry;
  }

  private finalizeUserTurn(text: string): void {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    if (this.finalizedUserTurn && this.finalizedUserText === normalized) return;

    this.finalizedUserTurn = true;
    this.finalizedUserText = normalized;
    const turnId = this.pendingUserTurnId ?? this.nextTurnId();
    this.pendingUserTurnId = null;
    this.latestReactionTurnId = turnId;
    this.eligibleUserReactionTurnId = turnId;
    // Semantic transcription can complete after the voice response has
    // already been created. Associate that response with this turn so a fast
    // analyzer result can still arrive during its audible window.
    if (this.activeVoiceTurnId === null && this.responseActive) {
      this.activeVoiceTurnId = turnId;
      this.voiceResponseEnded = false;
    }
    if (this.activeVoiceTurnId === turnId) {
      this.voiceUserText = normalized;
      this.prepareFastSpeechCues();
    }
    // A correction can arrive before generation.done for the old reply.
    // Place its assistant context before the new user turn, then keep this
    // entry updated/trimmed as the old audio completes or hands off.
    if (this.outputMeterActive && this.activeVoiceTurnId !== turnId && !this.assistantContextRecorded) {
      this.assistantContextEntry = this.recordContext("assistant", this.presentedAssistantTranscript);
      this.assistantContextRecorded = this.assistantContextEntry !== null;
    }
    this.recordContext("user", normalized);

    this.prepareGrounding(turnId, normalized);

    // A reaction request is independent from the audio response. It is sent
    // after the final transcript is available, but the voice response never
    // waits for this request to finish.
    // Do the interpretation during overlap, not after the handoff. A ready
    // result is held until the previous audible reply releases the character.
    // This saves the extra analysis round trip without acting the new meaning
    // on top of words that still belong to the old reply.
    if (this.reactionsEnabled) this.startReactionAnalysis(turnId, normalized, this.recentContext);
  }

  private startReactionAnalysis(
    turnId: string,
    userText: string,
    context: readonly ReactionContextTurn[],
  ): void {
    if (!this.reactionsEnabled) return;
    const requestId = `reaction-${this.sessionGeneration}-${++this.reactionRequestSequence}`;
    const request: ReactionRequest = {
      requestId,
      kind: "reaction",
      turnId,
      userText,
      assistantText: "",
      responseId: null,
      responseText: "",
      startedAt: this.now(),
      timeoutId: null,
      timedOut: false,
      completed: false,
      emitted: false,
      rejectionReported: false,
      planParsed: false,
      receivedReported: false,
      pendingCues: [],
      plannedFrom: 0,
      plannedThrough: 0,
    };
    this.reactionRequests.set(requestId, request);
    this.reactionEventRequests.set(requestId, request);
    this.pruneReactionRequests();
    if (!this.nativeCharacterEnabled) this.emitReactionDiagnostic({ state: "requested", turnId });

    // Recognize only explicit, completed personal news immediately. Ambiguous
    // wording still belongs to the contextual director. The usual turn fences
    // hold this reaction through overlap until the older voice has yielded.
    const immediate = deriveImmediateUserCue({ turnId, text: userText, cueId: `${requestId}-immediate` });
    if (immediate) {
      request.preparedCue = immediate;
      this.emitReactionDiagnostic({ state: "prepared", turnId, elapsedMs: 0, reason: "explicit_user_event" });
      this.tryEmitReaction(request);
    }

    // The native voice owns meaning now. Keep this zero-network recognition
    // as a conservative first reaction, but do not ask a second model to
    // reinterpret the same exchange or race the voice's chosen performance.
    if (this.nativeCharacterEnabled) {
      request.completed = true;
      return;
    }

    request.timeoutId = window.setTimeout(() => {
      if (request.completed || request.timedOut || request.emitted) return;
      request.timedOut = true;
      request.timeoutId = null;
      this.emitReactionDiagnostic({
        state: "timeout",
        turnId,
        elapsedMs: this.reactionElapsedMs(request),
      });
      this.emitSafeReactionFallback(request);
    }, REACTION_TIMEOUT_MS);

    this.sendEvent({
      type: "response.create",
      event_id: requestId,
      response: {
        conversation: "none",
        output_modalities: ["text"],
        max_output_tokens: 224,
        tools: [REACTION_TOOL],
        tool_choice: { type: "function", name: REACTION_TOOL.name },
        metadata: {
          kind: REACTION_RESPONSE_KIND,
          turn_id: turnId,
          request_id: requestId,
        },
        // Keep rules static and provide the exact bounded transcript as an
        // explicit input item. Without this, an OOB response can inherit the
        // live session's previous conversation/audio and repeat a stale mood
        // after a user corrects themselves.
        instructions: REACTION_ANALYZER_INSTRUCTIONS,
        input: [{
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: buildReactionAnalysisInput(turnId, context),
          }],
        }],
      },
    });
  }

  private startSpeechPlanAnalysis(
    turnId: string,
    assistantText: string,
    context: readonly ReactionContextTurn[],
    plannedFrom: number,
    plannedThrough: number,
  ): void {
    const normalized = assistantText.trim();
    if (
      !this.reactionsEnabled
      ||
      !normalized
      || this.speechPlanRequestActive
      || turnId !== this.activeVoiceTurnId
      || (turnId !== this.latestReactionTurnId && !this.outputMeterActive)
      || this.voiceResponseEnded
    ) return;

    const requestId = `speech-plan-${this.sessionGeneration}-${++this.reactionRequestSequence}`;
    const request: ReactionRequest = {
      requestId,
      kind: "speech_plan",
      turnId,
      userText: this.voiceUserText,
      assistantText: normalized,
      responseId: null,
      responseText: "",
      startedAt: this.now(),
      timeoutId: null,
      timedOut: false,
      completed: false,
      emitted: false,
      rejectionReported: false,
      planParsed: false,
      receivedReported: false,
      pendingCues: [],
      plannedFrom,
      plannedThrough,
    };
    this.speechPlanRequestActive = true;
    this.speechPlanRequestId = requestId;
    this.speechPlanRequestedThrough = Math.max(this.speechPlanRequestedThrough, plannedThrough);
    this.reactionRequests.set(requestId, request);
    this.reactionEventRequests.set(requestId, request);
    this.pruneReactionRequests();
    this.emitReactionDiagnostic({ state: "requested", turnId });

    request.timeoutId = window.setTimeout(() => {
      if (request.completed || request.timedOut || request.emitted) return;
      request.timedOut = true;
      request.timeoutId = null;
      if (this.speechPlanRequestId === request.requestId) {
        this.speechPlanRequestActive = false;
        this.speechPlanRequestId = null;
        if (request.turnId === this.activeVoiceTurnId) {
          this.speechPlanCoveredChars = Math.max(this.speechPlanCoveredChars, request.plannedThrough);
        }
      }
      this.emitReactionDiagnostic({
        state: "timeout",
        turnId,
        elapsedMs: this.reactionElapsedMs(request),
        reason: "speech_plan_timeout",
      });
      this.maybeStartSpeechPlanAnalysis(true);
    }, SPEECH_PLAN_TIMEOUT_MS);

    this.sendEvent({
      type: "response.create",
      event_id: requestId,
      response: {
        conversation: "none",
        output_modalities: ["text"],
        max_output_tokens: SPEECH_PLAN_MAX_OUTPUT_TOKENS,
        tools: [SPEECH_PLAN_TOOL],
        tool_choice: { type: "function", name: SPEECH_PLAN_TOOL.name },
        metadata: {
          kind: SPEECH_PLAN_RESPONSE_KIND,
          turn_id: turnId,
          request_id: requestId,
          planned_through: String(plannedThrough),
        },
        instructions: SPEECH_PLAN_ANALYZER_INSTRUCTIONS,
        input: [{
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: buildSpeechPlanInput(turnId, context, normalized),
          }],
        }],
      },
    });
  }

  private nextSpeechPlanBoundary(forceRemainder = false): number | null {
    const start = this.speechPlanCoveredChars;
    const remainder = this.generatedTranscript.slice(start);
    if (!remainder.trim()) return null;

    const clauseEnds = [...remainder.matchAll(/[.!?…]+(?=\s|["'”’)]|$)/gu)]
      .map((match) => (match.index ?? 0) + match[0].length);
    // Start directing the first thought while it is being spoken, not after
    // two entire sentences have been generated. Batch two when already ready.
    if (clauseEnds.length > 0 && clauseEnds[0] >= MIN_PLAN_TEXT_LENGTH) {
      return start + (clauseEnds[1] ?? clauseEnds[0]);
    }
    const words = [...remainder.matchAll(/\S+\s+/gu)];
    if (words.length >= 12) {
      const last = words[11];
      return start + (last.index ?? 0) + last[0].length;
    }
    if (forceRemainder && remainder.trim().length >= MIN_PLAN_TEXT_LENGTH) return this.generatedTranscript.length;
    return null;
  }

  private maybeStartSpeechPlanAnalysis(forceRemainder = false): void {
    if (this.nativeCharacterEnabled || !this.reactionsEnabled) return;
    if (
      (!this.responseActive && !this.assistantTranscriptComplete && !forceRemainder)
      || this.voiceResponseEnded
      || !this.activeVoiceTurnId
      || (this.activeVoiceTurnId !== this.latestReactionTurnId && !this.outputMeterActive)
      || this.speechPlanRequestActive
    ) return;
    const boundary = this.nextSpeechPlanBoundary(forceRemainder || this.assistantTranscriptComplete);
    if (boundary === null || boundary <= this.speechPlanRequestedThrough) return;
    const rawText = this.generatedTranscript.slice(this.speechPlanCoveredChars, boundary);
    const text = rawText.trim();
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    this.startSpeechPlanAnalysis(
      this.activeVoiceTurnId,
      text,
      this.recentContext,
      this.speechPlanCoveredChars + leadingWhitespace,
      boundary,
    );
  }

  private pruneReactionRequests(): void {
    if (this.reactionRequests.size <= MAX_REACTION_REQUESTS) return;
    for (const [requestId, request] of this.reactionRequests) {
      if ((!request.completed && !request.timedOut) || request.pendingCues.length > 0) continue;
      if (request.preparedCue && !request.emitted && request.turnId === this.latestReactionTurnId && this.userReactionState(request) === "waiting") continue;
      this.reactionRequests.delete(requestId);
      this.reactionEventRequests.delete(requestId);
      if (request.responseId) {
        this.retiredAnalysisResponses.add(request.responseId);
        this.reactionResponses.delete(request.responseId);
      }
      if (this.reactionRequests.size <= MAX_REACTION_REQUESTS) return;
    }
  }

  private reactionRequestForEvent(event: WireEvent): ReactionRequest | null {
    const responseId = this.responseIdForEvent(event);
    if (responseId) {
      const known = this.reactionResponses.get(responseId);
      if (known) return known;
    }

    const metadata = event.response?.metadata;
    if (
      metadata
      && (metadata.kind === REACTION_RESPONSE_KIND || metadata.kind === SPEECH_PLAN_RESPONSE_KIND)
    ) {
      const requestId = typeof metadata.request_id === "string" ? metadata.request_id : null;
      const request = requestId ? this.reactionRequests.get(requestId) : null;
      if (request) {
        if (responseId) {
          request.responseId = responseId;
          this.reactionResponses.set(responseId, request);
        }
        return request;
      }
    }

    // The outer event_id identifies the server event. On an error, the
    // nested id points to the original client request we must isolate.
    const eventId = event.error?.event_id ?? event.event_id;
    return eventId ? this.reactionEventRequests.get(eventId) ?? null : null;
  }

  private responseIdForEvent(event: WireEvent): string | null {
    if (typeof event.response_id === "string") return event.response_id;
    return typeof event.response?.id === "string" ? event.response.id : null;
  }

  private isVoiceLifecycleEvent(event: WireEvent): boolean {
    const type = event.type ?? "";
    return type === "response.created"
      || type === "response.done"
      || type.startsWith("response.function_call_arguments.")
      || type.startsWith("response.output_")
      || type.startsWith("output_audio_buffer.");
  }

  private responseTextFromDone(event: WireEvent): string {
    const output = event.response?.output ?? [];
    return output
      .flatMap((item) => [
        ...(item.type === "function_call" && typeof item.arguments === "string" ? [item.arguments] : []),
        ...(typeof item.text === "string" ? [item.text] : []),
        ...(item.content ?? []).flatMap((content) => (
          typeof content.text === "string" ? [content.text]
            : typeof content.transcript === "string" ? [content.transcript]
              : []
        )),
      ])
      .join("");
  }

  private reactionElapsedMs(request: ReactionRequest): number {
    return Math.max(0, Math.round(this.now() - request.startedAt));
  }

  private reportReactionRejection(request: ReactionRequest, reason: string): void {
    if (request.rejectionReported) return;
    request.rejectionReported = true;
    this.emitReactionDiagnostic({
      state: "rejected",
      turnId: request.turnId,
      elapsedMs: this.reactionElapsedMs(request),
      reason,
    });
  }

  private emitSafeReactionFallback(request: ReactionRequest): void {
    if (
      request.kind !== "reaction"
      || request.emitted
      || !this.canEmitReaction(request)
      || this.emittedSpeechTurns.has(request.turnId)
    ) return;
    request.emitted = true;
    this.callbacks.onReactionCue?.({
      id: `${request.requestId}-fallback`,
      turnId: request.turnId,
      source: "user",
      expression: "neutral",
      intensity: 0,
      effect: "none",
      confidence: 0,
    });
  }

  private canEmitReaction(request: ReactionRequest): boolean {
    if (request.kind === "reaction") return this.userReactionState(request) === "ready";
    return (request.turnId === this.latestReactionTurnId || this.outputMeterActive)
      && request.turnId === this.activeVoiceTurnId
      && !this.voiceResponseEnded;
  }

  private userReactionState(request: ReactionRequest): "ready" | "waiting" | "stale_turn" | "voice_ended" {
    if (
      this.closed
      || request.turnId !== this.latestReactionTurnId
      || request.turnId !== this.eligibleUserReactionTurnId
      || (this.pendingUserTurnId !== null && this.pendingUserTurnId !== request.turnId)
    ) return "stale_turn";
    if (request.turnId === this.activeVoiceTurnId && this.voiceResponseEnded) return "voice_ended";
    if (
      this.activeVoiceTurnId !== request.turnId
      && (this.responseActive || this.outputMeterActive || this.handoffPending)
    ) return "waiting";
    return "ready";
  }

  private emitPreparedUserReaction(): void {
    for (const request of this.reactionRequests.values()) {
      if (request.kind === "reaction" && request.turnId === this.latestReactionTurnId) {
        this.tryEmitReaction(request);
      }
    }
  }

  private reportSpeechCueReceived(request: ReactionRequest): void {
    if (request.receivedReported) return;
    request.receivedReported = true;
    this.emitReactionDiagnostic({
      state: "received",
      turnId: request.turnId,
      elapsedMs: this.reactionElapsedMs(request),
    });
  }

  private speechAnchorState(
    request: ReactionRequest,
    cue: ReactionCue,
  ): "waiting" | "ready" | "past" | "invalid" {
    if (!cue.anchor) return "invalid";
    const normalize = (value: string) => value.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').toLocaleLowerCase();
    const text = normalize(request.assistantText);
    const anchor = normalize(cue.anchor);
    const anchorStart = text.indexOf(anchor);
    if (anchorStart < 0) return "invalid";
    const firstWord = anchor.trim().match(/^\S+/u)?.[0] ?? anchor;
    const absoluteStart = request.plannedFrom + anchorStart;
    const triggerAt = absoluteStart + Math.max(1, firstWord.length);
    // An anchor is the beginning of a phrase, not its entire duration. A
    // plan arriving after its first few words can still act the current
    // clause; it must not replay a clause that is already finished.
    const clauseEnd = /[.!?;…]+(?=\s|$)/u.exec(text.slice(anchorStart));
    let localEnd = clauseEnd ? anchorStart + clauseEnd.index + clauseEnd[0].length : text.length;
    for (const next of request.pendingCues) {
      if (!next.anchor || next.id === cue.id) continue;
      const nextStart = text.indexOf(normalize(next.anchor));
      if (nextStart > anchorStart) localEnd = Math.min(localEnd, nextStart);
    }
    const endAt = request.plannedFrom + localEnd;
    const cursor = this.presentedAssistantTranscript.length;
    if (cursor >= endAt) return "past";
    // Let an authored face begin preparing just before the matching word.
    // Audio, captions and this lookahead still share one playback timeline.
    const anticipated = this.outputWasAudible && this.outputLevel > OUTPUT_AUDIBLE_THRESHOLD
      ? this.timeline.peek(this.playbackElapsedMs(), ACTING_LEAD_MS).charEnd : cursor;
    if (Math.max(cursor, anticipated) >= triggerAt) return "ready";
    return "waiting";
  }

  private emitAvailableSpeechCues(): void {
    if (this.voiceCharacter.hasPlan) {
      const audible = this.outputWasAudible && this.transcriptCanPlay
        && !this.voiceResponseEnded && !this.responseInterrupted && !this.handoffPending;
      const cursor = this.presentedAssistantTranscript.length;
      const anticipated = audible && this.outputLevel > OUTPUT_AUDIBLE_THRESHOLD
        ? this.timeline.peek(this.playbackElapsedMs(), ACTING_LEAD_MS).charEnd : cursor;
      for (const cue of this.voiceCharacter.release({
        text: this.generatedTranscript,
        presentedChars: cursor,
        anticipatedChars: anticipated,
        complete: this.assistantTranscriptComplete,
        audible,
      })) this.callbacks.onReactionCue?.(cue);
      if (this.voiceCharacter.hasActiveBeat) return;
    }
    const planRequests = [...this.reactionRequests.values()]
      .filter((request) => request.kind === "speech_plan" && request.pendingCues.length > 0)
      .sort((left, right) => left.startedAt - right.startedAt);

    for (const request of planRequests) {
      while (request.pendingCues.length > 0) {
        const cue = request.pendingCues[0];
        if (!this.canEmitReaction(request)) {
          request.pendingCues.shift();
          this.reportReactionRejection(
            request,
            request.turnId !== this.latestReactionTurnId ? "stale_turn" : "voice_ended",
          );
          continue;
        }
        const anchorState = this.speechAnchorState(request, cue);
        if (anchorState === "invalid") {
          request.pendingCues.shift();
          this.reportReactionRejection(request, "invalid_phrase_anchor");
          continue;
        }
        if (anchorState === "past") {
          request.pendingCues.shift();
          this.reportReactionRejection(request, "phrase_already_presented");
          continue;
        }
        if (anchorState === "waiting") break;

        request.pendingCues.shift();
        const absoluteStart = request.plannedFrom + this.speechAnchorOffset(request.assistantText, cue.anchor);
        // A meaningful fast beat must not replay when its slower plan arrives.
        // A neutral placeholder is different: allow one confident refinement
        // while that same phrase is still audible, without restarting an old
        // phrase or erasing a more recent performance.
        const fast = this.fastSpeechCues.get(absoluteStart);
        if (fast?.emitted) {
          const cursor = this.presentedAssistantTranscript.length;
          const newerBeat = [...this.authoredSpeechStarts].some(at => at > absoluteStart && at <= cursor)
            || [...this.fastSpeechCues].some(([at, entry]) => at > absoluteStart && at <= cursor && entry.emitted);
          if (this.authoredSpeechStarts.has(absoluteStart)
            || fast.cue.expression !== "neutral" || fast.cue.intent !== "explain"
            || cue.expression === "neutral" || cue.confidence < 0.8
            || cursor >= fast.end || newerBeat
            || !this.outputWasAudible || this.outputLevel <= OUTPUT_AUDIBLE_THRESHOLD
            || !this.transcriptCanPlay) continue;
        }
        this.authoredSpeechStarts.add(absoluteStart);
        this.emittedSpeechTurns.add(request.turnId);
        this.reportSpeechCueReceived(request);
        this.callbacks.onReactionCue?.(cue);
      }
    }
    this.emitFastSpeechCues();
  }

  private speechAnchorOffset(text: string, anchor: string | undefined): number {
    const normalize = (value: string) => value.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').toLocaleLowerCase();
    return normalize(text).indexOf(normalize(anchor ?? ""));
  }

  private refineCurrentFastSpeechCue(
    turnId: string,
    phrase: string,
    phraseIndex: number,
    start: number,
    end: number,
    existing: { cue: ReactionCue; end: number; emitted: boolean },
  ): void {
    // Late ASR may make an already-visible generic acknowledgement meaningful,
    // but it must never rewind a finished phrase or replace an authored beat.
    if (
      this.lateContextRefinedStarts.has(start)
      || this.authoredSpeechStarts.has(start)
      || existing.cue.expression !== "neutral"
      || existing.cue.intent !== "explain"
      || !this.outputWasAudible
      || this.outputLevel <= OUTPUT_AUDIBLE_THRESHOLD
      || !this.transcriptCanPlay
    ) return;

    const cursor = this.presentedAssistantTranscript.length;
    const newerBeat = [...this.authoredSpeechStarts].some(at => at > start && at <= cursor)
      || [...this.fastSpeechCues].some(([at, entry]) => at > start && at <= cursor && entry.emitted);
    if (cursor >= end || newerBeat) return;

    const refined = deriveFastSpeechCue({
      turnId,
      phrase,
      userText: this.voiceUserText,
      phraseIndex,
      // The avatar latches a performance by cue id. A genuine semantic
      // revision needs a new identity so its visible pose can retarget from
      // the current frame instead of only changing the mood label.
      cueId: `${turnId}:fast:${start}:context`,
    });
    if (
      !refined
      || refined.expression === "neutral"
      || refined.intent === "explain"
      || refined.confidence < 0.8
      || refined.effect !== "none"
    ) return;

    existing.cue = refined;
    existing.end = end;
    this.lateContextRefinedStarts.add(start);
    this.callbacks.onReactionCue?.(refined);
  }

  private prepareFastSpeechCues(): void {
    if (this.voiceCharacter.hasActiveBeat) return;
    const turnId = this.activeVoiceTurnId;
    if (!turnId || this.voiceResponseEnded || this.responseInterrupted) return;
    for (const [index, span] of speechBeatSpans(this.generatedTranscript, this.assistantTranscriptComplete).entries()) {
      const existing = this.fastSpeechCues.get(span.start);
      if (existing?.emitted) {
        // Keep the current phrase's end accurate as its remaining words arrive;
        // its visible pose and stable start never restart on a transcript delta.
        existing.end = span.end;
        this.refineCurrentFastSpeechCue(turnId, span.text, index, span.start, span.end, existing);
        continue;
      }
      const cue = deriveFastSpeechCue({
        turnId, phrase: span.text, userText: this.voiceUserText, phraseIndex: index,
        cueId: `${turnId}:fast:${span.start}`,
      });
      if (cue) {
        // A neutral opening acknowledgement does not undo clearly recognized
        // news. Carry that first face into "Oh, right"/"That's huge", while
        // later clauses and explicit speech meanings keep their own cues.
        const spokenSoFar = this.generatedTranscript.slice(0, span.end);
        const carriesShortReaction = this.nativeCharacterEnabled
          && captionWords(spokenSoFar).length <= 28
          && !/\b(?:but|however|actually|instead|different topic|on the other hand)\b/iu.test(spokenSoFar);
        const recognized = (index === 0 || carriesShortReaction) && cue.expression === "neutral"
          ? [...this.reactionRequests.values()].find(request => request.kind === "reaction"
            && request.turnId === turnId && (request.preparedCue?.confidence ?? 0) >= 0.85)?.preparedCue
          : undefined;
        const visibleCue = recognized && recognized.expression !== "neutral"
          ? { ...cue, expression: recognized.expression,
              intensity: Math.min(0.82, recognized.intensity),
              // A weak generic continuation is not a new emotional intent.
              // Preserve recognized care/joy through a short thought while
              // keeping each clause's finite head beat and native cue priority.
              ...(carriesShortReaction ? { intent: recognized.intent ?? cue.intent } : {}),
              accent: recognized.accent ?? cue.accent }
          : cue;
        this.fastSpeechCues.set(span.start, { cue: visibleCue, end: span.end, emitted: false });
      }
    }
  }

  private emitFastSpeechCues(): void {
    if (this.voiceCharacter.hasActiveBeat) return;
    if (!this.outputWasAudible || this.voiceResponseEnded || this.responseInterrupted || !this.transcriptCanPlay) return;
    const cursor = this.presentedAssistantTranscript.length;
    const anticipated = this.outputLevel > OUTPUT_AUDIBLE_THRESHOLD
      ? this.timeline.peek(this.playbackElapsedMs(), ACTING_LEAD_MS).charEnd : cursor;
    for (const [start, entry] of this.fastSpeechCues) {
      if (entry.emitted) continue;
      if (cursor >= entry.end || [...this.authoredSpeechStarts].some(at => at >= start && at < entry.end)) {
        entry.emitted = true;
        continue;
      }
      const firstWordLength = entry.cue.anchor?.match(/^\S+/u)?.[0].length ?? 1;
      if (Math.max(cursor, anticipated) < start + firstWordLength) continue;
      entry.emitted = true;
      this.emittedSpeechTurns.add(entry.cue.turnId);
      this.callbacks.onReactionCue?.(entry.cue);
    }
  }

  private tryEmitSpeechPlan(request: ReactionRequest): boolean {
    if (request.planParsed || request.timedOut) return request.planParsed;
    if (
      request.requestId !== this.speechPlanRequestId
      || (request.turnId !== this.latestReactionTurnId && !this.outputMeterActive)
      || request.turnId !== this.activeVoiceTurnId
    ) {
      this.reportReactionRejection(request, "stale_plan");
      return false;
    }
    if (!request.captionsParsed && !this.voiceResponseEnded) {
      const breaks = parseCaptionBreaks(request.responseText, request.assistantText);
      if (breaks) {
        const offset = captionWords(this.generatedTranscript.slice(0, request.plannedFrom)).length;
        for (const at of breaks) this.authoredCaptionBreaks.add(offset + at);
        request.captionsParsed = true;
        this.updateCaptionPlan();
      }
    }
    const complete = completeJsonObject(request.responseText);
    const parseOptions = {
      idPrefix: request.requestId,
      turnId: request.turnId,
      currentAssistantText: request.assistantText,
      currentUserText: request.userText,
      maxCues: MAX_SPEECH_PLAN_CUES,
    };
    const cues = complete ? parseReactionPlan(complete, parseOptions)
      : parseStreamingReactionPlan(request.responseText, parseOptions);
    if (!cues) return false;

    const previousCount = request.parsedCueCount ?? 0;
    if (cues.length < previousCount) return false;
    request.parsedCueCount = cues.length;
    if (complete) {
      request.planParsed = true;
      request.emitted = true;
      this.speechPlanCoveredChars = Math.max(this.speechPlanCoveredChars, request.plannedThrough);
    }

    // A plan that arrives after its words were already presented is stale.
    // Drop those beats instead of replaying them on the next phrase.
    const newCues = cues.slice(previousCount).filter((cue) => {
      const anchorState = this.speechAnchorState(request, cue);
      if (anchorState === "invalid") {
        this.reportReactionRejection(request, "invalid_phrase_anchor");
        return false;
      }
      if (anchorState === "past") {
        this.reportReactionRejection(request, "phrase_already_presented");
        return false;
      }
      // A cue whose words are currently being presented remains eligible; it
      // will fire at the first-word boundary instead of replaying later.
      return true;
    });
    request.pendingCues.push(...newCues);
    this.emitAvailableSpeechCues();
    return request.planParsed;
  }

  private tryEmitReaction(request: ReactionRequest): boolean {
    if (request.kind !== "reaction" || request.emitted || request.timedOut) return request.emitted;
    if (!request.preparedCue) {
      const complete = completeJsonObject(request.responseText);
      if (!complete) return false;
      const cue = parseReactionCue(complete, {
        id: request.requestId,
        turnId: request.turnId,
        source: "user",
        currentUserText: request.userText,
      });
      if (!cue) return false;
      request.preparedCue = cue;
      this.emitReactionDiagnostic({ state: "prepared", turnId: request.turnId, elapsedMs: this.reactionElapsedMs(request) });
    }
    const eligibility = this.userReactionState(request);
    if (eligibility === "waiting") return false;
    if (eligibility !== "ready") {
      this.reportReactionRejection(request, eligibility);
      return false;
    }

    // A late turn-level cue must not replace a phrase beat that has already
    // become visible for this same spoken response.
    if (this.emittedSpeechTurns.has(request.turnId)
      || (request.turnId === this.activeVoiceTurnId && this.voiceCharacter.hasActiveBeat)) {
      this.reportReactionRejection(request, "reaction_after_speech_plan");
      return false;
    }

    request.emitted = true;
    this.emitReactionDiagnostic({
      state: "received",
      turnId: request.turnId,
      elapsedMs: this.reactionElapsedMs(request),
    });
    this.callbacks.onReactionCue?.(request.preparedCue);
    return true;
  }

  private handleSpeechPlanEvent(event: WireEvent, request: ReactionRequest): void {
    const responseId = this.responseIdForEvent(event);
    if (responseId) {
      request.responseId = responseId;
      this.reactionResponses.set(responseId, request);
    }

    if ((event.type === "response.output_text.delta" || event.type === "response.function_call_arguments.delta") && !request.timedOut && typeof event.delta === "string") {
      request.responseText += event.delta;
      this.tryEmitSpeechPlan(request);
      return;
    }

    if ((event.type === "response.output_text.done" || event.type === "response.function_call_arguments.done") && !request.timedOut) {
      if (typeof event.arguments === "string") request.responseText = event.arguments;
      else if (typeof event.text === "string") request.responseText = event.text;
      else if (typeof event.delta === "string") request.responseText = event.delta;
      this.tryEmitSpeechPlan(request);
      return;
    }

    if (event.type !== "response.done" && event.type !== "error") return;
    if (request.completed) return;

    request.completed = true;
    const isCurrentPlan = this.speechPlanRequestId === request.requestId;
    if (request.timeoutId !== null) {
      window.clearTimeout(request.timeoutId);
      request.timeoutId = null;
    }
    if (event.type === "error" || event.response?.status === "failed") {
      if (isCurrentPlan) {
        this.speechPlanRequestActive = false;
        this.speechPlanRequestId = null;
      }
      if (isCurrentPlan && request.turnId === this.activeVoiceTurnId) {
        this.speechPlanCoveredChars = Math.max(this.speechPlanCoveredChars, request.plannedThrough);
      }
      this.emitReactionDiagnostic({
        state: "failed",
        turnId: request.turnId,
        elapsedMs: this.reactionElapsedMs(request),
        reason: event.type === "error" ? "speech_plan_error" : "speech_plan_failed",
      });
      this.maybeStartSpeechPlanAnalysis();
      return;
    }
    if (request.timedOut) return;

    if (!request.responseText) request.responseText = this.responseTextFromDone(event);
    if (!isCurrentPlan) {
      this.reportReactionRejection(request, "stale_plan");
      return;
    }
    if (!this.tryEmitSpeechPlan(request)) {
      this.speechPlanCoveredChars = Math.max(this.speechPlanCoveredChars, request.plannedThrough);
      this.reportReactionRejection(request, "invalid_speech_plan");
    } else if (request.pendingCues.length === 0 && !request.receivedReported) {
      this.reportReactionRejection(request, "no_actionable_phrase");
    }
    if (isCurrentPlan) {
      this.speechPlanRequestActive = false;
      this.speechPlanRequestId = null;
    }
    this.emitAvailableSpeechCues();
    this.maybeStartSpeechPlanAnalysis();
  }

  private handleReactionEvent(event: WireEvent, request: ReactionRequest): void {
    if (request.kind === "speech_plan") {
      this.handleSpeechPlanEvent(event, request);
      return;
    }

    const responseId = this.responseIdForEvent(event);
    if (responseId) {
      request.responseId = responseId;
      this.reactionResponses.set(responseId, request);
    }

    if ((event.type === "response.output_text.delta" || event.type === "response.function_call_arguments.delta") && !request.timedOut && typeof event.delta === "string") {
      request.responseText += event.delta;
      this.tryEmitReaction(request);
      return;
    }

    if ((event.type === "response.output_text.done" || event.type === "response.function_call_arguments.done") && !request.timedOut) {
      if (typeof event.arguments === "string") request.responseText = event.arguments;
      else if (typeof event.text === "string") request.responseText = event.text;
      else if (typeof event.delta === "string") request.responseText = event.delta;
      this.tryEmitReaction(request);
      return;
    }

    if (event.type !== "response.done" && event.type !== "error") return;
    if (request.completed) return;

    request.completed = true;
    if (request.timeoutId !== null) {
      window.clearTimeout(request.timeoutId);
      request.timeoutId = null;
    }
    if (event.type === "error" || event.response?.status === "failed") {
      request.timedOut = true;
      request.preparedCue = undefined;
      this.emitReactionDiagnostic({
        state: "failed",
        turnId: request.turnId,
        elapsedMs: this.reactionElapsedMs(request),
        reason: event.type === "error" ? "analysis_error" : "analysis_failed",
      });
      this.emitSafeReactionFallback(request);
      return;
    }
    if (request.timedOut) {
      this.emitSafeReactionFallback(request);
      return;
    }

    if (!request.responseText) request.responseText = this.responseTextFromDone(event);
    if (this.tryEmitReaction(request)) return;
    if (request.preparedCue && this.userReactionState(request) === "waiting") return;
    if (!this.canEmitReaction(request)) {
      this.reportReactionRejection(
        request,
        request.turnId !== this.latestReactionTurnId ? "stale_turn" : "voice_ended",
      );
      return;
    }
    this.reportReactionRejection(
      request,
      completeJsonObject(request.responseText) ? "invalid_json" : "incomplete_json",
    );
    this.emitSafeReactionFallback(request);
  }

  private resetNativeCharacter(turnId: string | null = null): void {
    this.voiceCharacter.reset(turnId);
    this.nativeToolCalls.clear();
    this.nativeToolResponseIds.clear();
    this.nativeSilent = false;
    this.nativeContinuationUsed = false;
    this.pendingNativeContinuation = false;
  }

  private publishCharacterContext(takingOver: boolean): void {
    if (!this.nativeCharacterEnabled && !takingOver) return;
    // Replace, rather than accumulate, stale visual snapshots in conversation
    // history. This is app-owned context, separate from the user's words.
    if (this.characterContextItemId) {
      this.sendEvent({ type: "conversation.item.delete", item_id: this.characterContextItemId });
    }
    this.characterContextItemId = `face_ctx_${this.sessionGeneration}_${++this.characterContextSequence}`;
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        id: this.characterContextItemId,
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: characterContext(this.callbacks.getCharacterState?.(), this.now(), takingOver) }],
      },
    });
  }

  private handleCharacterCall(item: WireOutputItem, responseId: string | null): void {
    if (!this.nativeCharacterEnabled || !responseId || responseId !== this.activeVoiceResponseId
      || !this.activeVoiceTurnId || this.voiceResponseEnded || this.responseInterrupted || this.handoffPending
      || item.type !== "function_call" || item.status === "incomplete"
      || typeof item.call_id !== "string" || !item.call_id || item.call_id.length > 128
      || this.nativeToolCalls.has(item.call_id)) return;

    this.nativeToolCalls.add(item.call_id);
    this.nativeToolResponseIds.add(responseId);
    const plan = item.name === CHARACTER_TOOL_NAME && typeof item.arguments === "string"
      ? parseCharacterPerformance(item.arguments) : null;
    const superseded = this.queuedUserTurn && this.latestReactionTurnId !== this.activeVoiceTurnId;
    const accepted = plan !== null && !superseded && !this.voiceCharacter.hasPlan && !this.nativeContinuationUsed;
    if (accepted) {
      this.nativeSilent = plan.silent;
      const immediate = this.voiceCharacter.accept(plan, item.call_id);
      // Once the voice owns a performance, slower interpretations and local
      // semantic fallbacks must not fight it. Articulation still stays local.
      if (immediate) {
        this.fastSpeechCues.clear();
        this.emittedSpeechTurns.add(this.activeVoiceTurnId);
      }
      for (const request of this.reactionRequests.values()) {
        if (request.turnId !== this.activeVoiceTurnId) continue;
        request.pendingCues = [];
        request.emitted = true;
        request.completed = true;
        if (request.timeoutId !== null) window.clearTimeout(request.timeoutId);
        request.timeoutId = null;
      }
      if (immediate) this.callbacks.onReactionCue?.(immediate);
      this.emitAvailableSpeechCues();
      this.emitReactionDiagnostic({ state: "received", turnId: this.activeVoiceTurnId,
        reason: plan.silent ? "voice_authored_nonverbal" : "voice_authored_performance" });
    } else {
      this.emitReactionDiagnostic({ state: "rejected", turnId: this.activeVoiceTurnId,
        reason: superseded ? "superseded_by_newer_turn" : plan ? "one_character_plan_per_turn" : "invalid_character_performance" });
    }
    // A queued action is not proof that a frame has been shown. The following
    // response can see a fresh painted snapshot via App context instead.
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(accepted
          ? { status: "scheduled", beats: plan.beats.length, silent: plan.silent, rendered: false,
              speech_anchors: plan.beats.map(beat => beat.anchor).filter(Boolean),
              next: plan.silent ? "Nonverbal request fulfilled; no spoken continuation."
                : "Continue your short spoken reply, using the planned anchor words naturally. Do not describe the tool." }
          : { status: "rejected", reason: superseded ? "superseded_by_newer_turn" : plan ? "already_performed_this_turn" : "invalid_arguments" }),
      },
    });
  }

  /** A tool-only turn needs one continuation; a mixed audio/tool turn does not. */
  private finishCharacterToolResponse(event: WireEvent): boolean {
    const responseId = this.responseIdForEvent(event);
    if (!this.nativeCharacterEnabled || event.type !== "response.done" || !responseId
      || responseId !== this.activeVoiceResponseId || this.responseInterrupted || this.handoffPending) return false;
    if (event.response?.status === "completed") {
      for (const item of event.response.output ?? []) this.handleCharacterCall(item, responseId);
    }
    const toolResponse = this.nativeToolResponseIds.has(responseId)
      || event.response?.output?.some(item => item.type === "function_call");
    if (!toolResponse) return false;
    const hasSpokenOutput = this.responseHasAudio || this.generatedTranscript.trim().length > 0
      || event.response?.output?.some(item => item.type === "message"
        && item.content?.some(content => content.type === "audio" || content.type === "output_audio"));
    if (hasSpokenOutput) return false;

    this.responseActive = false;
    this.retireVoiceResponseId(responseId);
    this.activeVoiceResponseId = null;
    this.outputMeterActive = false;
    if (event.response?.status !== "completed" || this.nativeSilent || this.nativeContinuationUsed) {
      this.voiceResponseEnded = true;
      this.callbacks.onPhase("listening");
    } else {
      this.pendingNativeContinuation = true;
    }
    // A newer committed user turn wins over filler after a character call.
    this.requestQueuedResponse();
    return true;
  }

  private requestCharacterContinuation(): void {
    if (!this.pendingNativeContinuation || this.closed || this.userSpeechActive
      || this.queuedUserTurn || this.responseActive || this.outputMeterActive
      || this.handoffPending || this.outputClearPending || this.responseInterrupted) return;
    this.pendingNativeContinuation = false;
    this.nativeContinuationUsed = true;
    this.responseActive = true;
    this.voiceResponseEnded = false;
    this.publishCharacterContext(false);
    this.callbacks.onPhase("thinking");
    // An optional local tool may be emitted instead of audio. Do not force a
    // tool before every reply, and never allow a tool/continuation loop.
    this.sendVoiceResponse(true);
  }

  private sendVoiceResponse(continuation = false): void {
    const instructions = this.activeGroundingInstructions;
    if (!this.nativeCharacterEnabled) {
      this.sendEvent({
        type: "response.create",
        ...(instructions ? { response: { instructions } } : {}),
      });
      return;
    }
    this.voiceResponseRequestId = `voice-${this.sessionGeneration}-${++this.voiceResponseRequestSequence}`;
    this.awaitingVoiceResponse = true;
    this.sendEvent({
      type: "response.create",
      event_id: this.voiceResponseRequestId,
      response: {
        tool_choice: continuation ? "none" : "auto",
        ...(instructions ? { instructions } : {}),
        metadata: { kind: "voice", request_id: this.voiceResponseRequestId, turn_id: this.activeVoiceTurnId ?? "" },
      },
    });
  }

  private requestQueuedResponse(): void {
    if (!this.queuedUserTurn) {
      this.requestCharacterContinuation();
      return;
    }
    if (
      this.userSpeechActive
      || this.responseActive
      || this.outputMeterActive
      || this.outputClearPending
      || this.handoffPending
    ) return;
    if (this.grounding && !this.groundingState && !this.finalizedUserTurn) {
      if (this.inputTranscriptionFailed) {
        this.fail("SHERPA could not understand the question well enough to check the documents. Please try again.");
      }
      return;
    }
    const grounding = this.groundingState;
    if (grounding && grounding.turnId === (this.pendingUserTurnId ?? this.latestReactionTurnId)) {
      if (grounding.instructions === null) return;
      this.activeGroundingInstructions = grounding.instructions;
      this.groundingState = null;
    } else if (this.grounding) {
      // A turn that was not eligible for grounding must fail closed rather
      // than silently falling back to the personal companion persona.
      this.activeGroundingInstructions = buildGroundingInstructions(DEFAULT_GROUNDING_FAILURE, this.nativeCharacterEnabled);
    } else {
      this.activeGroundingInstructions = null;
    }
    if (this.inputTurnOverlapped && !this.inputTranscriptComplete && !this.userTranscript.trim()
      && !(this.nativeCharacterEnabled && this.inputHeldFloor)) {
      const remaining = OVERLAP_TRANSCRIPT_GRACE_MS - (this.now() - (this.inputCommittedAt ?? this.now()));
      if (remaining > 0) {
        // The old answer may drain before ASR identifies a harmless "yeah".
        // Give that classification a brief, bounded window, never an infinite
        // dependency: failed or missing ASR still releases the committed audio.
        this.inputCommittedAt ??= this.now();
        this.clearOverlapTranscriptTimer();
        this.overlapTranscriptTimer = window.setTimeout(() => {
          this.overlapTranscriptTimer = null;
          if (!this.closed) this.requestQueuedResponse();
        }, remaining);
        this.callbacks.onPhase("listening");
        return;
      }
    }
    this.clearOverlapTranscriptTimer();
    this.queuedUserTurn = false;
    this.activeVoiceTurnId = this.pendingUserTurnId ?? this.latestReactionTurnId;
    this.resetNativeCharacter(this.activeVoiceTurnId);
    this.voiceUserText = this.finalizedUserText || this.userTranscript;
    this.retireVoiceResponseId(this.activeVoiceResponseId);
    this.activeVoiceResponseId = null;
    this.voiceResponseEnded = false;
    this.assistantContextRecorded = false;
    this.assistantContextEntry = null;
    this.talkOver.reset();
    this.clearBargeInTimer();
    // Reserve the voice response before its server acknowledgement arrives.
    this.responseActive = true;
    this.responseInterrupted = false;
    // The new turn owns the bubble as soon as we enter thinking. Waiting for
    // response.created leaves the previous reply's words and word clock live.
    this.resetAssistantTranscript();
    this.publishCharacterContext(this.takingFloorContextPending);
    this.takingFloorContextPending = false;
    this.callbacks.onPhase("thinking");
    this.sendVoiceResponse();
    this.emitPreparedUserReaction();
  }

  private prepareGrounding(turnId: string, question: string): void {
    if (!this.grounding || this.closed) return;

    this.groundingState?.controller.abort();
    const controller = new AbortController();
    const generation = this.sessionGeneration;
    const previousQuestion = this.recentContext
      .filter((entry) => entry.role === "user" && entry.text !== question)
      .slice(-3)
      .map((entry) => entry.text)
      .join("\n")
      .slice(-4_000) || undefined;
    const state: GroundingState = {
      generation,
      turnId,
      controller,
      instructions: null,
      promise: Promise.resolve(),
    };
    this.groundingState = state;
    this.callbacks.onGrounding?.(null);

    const timeoutId = window.setTimeout(() => controller.abort(), GROUNDING_TIMEOUT_MS);
    state.promise = this.grounding({ question, previousQuestion, signal: controller.signal })
      .then((grounding) => {
        if (this.closed || generation !== this.sessionGeneration || this.groundingState !== state) return;
        if (grounding?.mode === "conversation") {
          state.instructions = buildConversationInstructions(this.nativeCharacterEnabled);
          this.callbacks.onGrounding?.({ mode: "conversation", context: "", sources: [] });
          this.requestQueuedResponse();
          return;
        }
        const context = grounding?.context?.trim().slice(0, MAX_GROUNDING_CONTEXT_CHARS);
        const normalized = context || DEFAULT_GROUNDING_FAILURE;
        state.instructions = buildGroundingInstructions(normalized, this.nativeCharacterEnabled, question);
        this.callbacks.onGrounding?.(grounding ? { ...grounding, context: normalized } : null);
        this.requestQueuedResponse();
      })
      .catch(() => {
        if (this.closed || generation !== this.sessionGeneration || this.groundingState !== state) return;
        this.fail("SHERPA could not verify the documents for this question. Please try again.");
      })
      .finally(() => window.clearTimeout(timeoutId));
  }

  private clearBargeInTimer(): void {
    if (this.bargeInTimer === null) return;
    window.clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
  }

  private retireVoiceResponseId(responseId: string | null): void {
    if (!responseId) return;
    this.retiredVoiceResponseIds.add(responseId);
    // A response id is only useful as a stale-event fence for a short window.
    // Keep the set bounded for long-running conversations.
    while (this.retiredVoiceResponseIds.size > 32) {
      const oldest = this.retiredVoiceResponseIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.retiredVoiceResponseIds.delete(oldest);
    }
  }

  private beginOutputClear(): void {
    if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
    this.outputClearPending = true;
    this.pendingOutputClearResponseId = this.activeVoiceResponseId;
    // The normal server acknowledgement is quick, but a missing ack must not
    // strand the latest user turn behind an old cancelled buffer forever.
    this.outputClearTimer = window.setTimeout(() => {
      this.outputClearTimer = null;
      if (this.closed || !this.outputClearPending) return;
      this.outputClearPending = false;
      this.pendingOutputClearResponseId = null;
      this.outputMeterActive = false;
      this.outputPlaybackEnded = true;
      this.voiceResponseEnded = true;
      this.responseInterrupted = true;
      this.retireVoiceResponseId(this.activeVoiceResponseId);
      this.activeVoiceResponseId = null;
      this.responseActive = false;
      this.clearBargeInTimer();
      if (this.queuedUserTurn) this.requestQueuedResponse();
    }, 1_000);
  }

  private nextTimelineOutputBoundary(now: number): { at: number; boundary: "phrase" | "sentence" } | null {
    if (!this.outputMeterActive && !this.responseHasAudio) return null;
    const elapsed = this.playbackElapsedMs();
    const firstIndex = Math.max(0, this.playbackWordTick - 1);
    const next = this.timeline.words.find((word) => {
      if (word.index < firstIndex || word.endMs <= elapsed) return false;
      return speechPunctuation(word.text) !== "none";
    });
    if (!next) return null;
    const punctuation = speechPunctuation(next.text);
    return {
      at: now + Math.max(0, next.endMs - elapsed),
      boundary: punctuation === "comma" ? "phrase" : "sentence",
    };
  }

  private checkTalkOver(outputBoundary?: TalkOverBoundary): void {
    this.clearBargeInTimer();
    if (this.closed || this.handoffPending || this.responseInterrupted) return;
    const now = this.now();
    let outputBoundaryAt: number | undefined;
    if (this.pendingOutputBoundary && now >= this.pendingOutputBoundary.at) {
      outputBoundary ??= this.pendingOutputBoundary.boundary;
      this.pendingOutputBoundary = null;
    } else if (this.pendingOutputBoundary) {
      outputBoundaryAt = this.pendingOutputBoundary.at;
    }
    const timelineBoundary = this.nextTimelineOutputBoundary(now);
    if (timelineBoundary && (outputBoundaryAt === undefined || timelineBoundary.at < outputBoundaryAt)) {
      outputBoundaryAt = timelineBoundary.at;
    }
    const decision = this.talkOver.update({
      nowMs: now,
      userSpeechActive: this.userSpeechActive,
      inputLevel: this.inputLevel,
      userTranscript: this.userTranscript,
      userTranscriptComplete: this.inputTranscriptComplete,
      userInputCommitted: this.inputAudioCommitted || this.inputTranscriptionFailed,
      userPaused: !this.userSpeechActive,
      assistantGenerating: this.responseActive,
      assistantAudioPlaying: this.outputMeterActive,
      outputBoundary,
      outputBoundaryAt,
      outputQuiet: this.outputWasAudible && this.outputQuietSince !== null && now - this.outputQuietSince >= 160,
    });
    if (!decision.handoff) {
      if (decision.nextCheckAt !== undefined && this.talkOver.pending) {
        this.bargeInTimer = window.setTimeout(() => this.checkTalkOver(), Math.max(16, Math.min(64, decision.nextCheckAt - now)));
      }
      return;
    }
    this.takingFloorContextPending = true;
    this.pendingNativeContinuation = false;
    this.handoffPending = true;
    this.callbacks.onHandoff?.(decision.reason);
    const fadeMs = decision.fadeMs ?? 160;
    const gain = this.outputGain?.gain;
    if (gain && this.outputContext) {
      const at = this.outputContext.currentTime;
      gain.cancelScheduledValues(at);
      gain.setValueAtTime(gain.value, at);
      gain.linearRampToValueAtTime(0, at + fadeMs / 1000);
    } else if (this.audioElement) {
      const audio = this.audioElement;
      const from = audio.volume;
      this.fadeCleanup = startFrameLoop(() => {
        audio.volume = Math.max(0, from * (1 - (this.now() - now) / fadeMs));
      });
    }
    const epoch = this.connectionEpoch;
    this.handoffTimer = window.setTimeout(() => {
      this.handoffTimer = null;
      this.fadeCleanup?.();
      this.fadeCleanup = null;
      if (this.closed || epoch !== this.connectionEpoch) return;
      this.handoffPending = false;
      this.responseInterrupted = true;
      this.voiceResponseEnded = true;
      this.discardUnheardTranscript();
      // Our reaction context must not remember the unheard end of a response.
      if (this.assistantContextEntry) {
        this.assistantContextEntry.text = this.presentedAssistantTranscript.trim();
        if (!this.assistantContextEntry.text) this.recentContext = this.recentContext.filter((entry) => entry !== this.assistantContextEntry);
      } else if (this.presentedAssistantTranscript.trim()) {
        this.assistantContextEntry = this.recordContext("assistant", this.presentedAssistantTranscript);
      }
      this.callbacks.onPhase("listening");
      if (this.responseActive) this.sendEvent({ type: "response.cancel", ...(this.activeVoiceResponseId ? { response_id: this.activeVoiceResponseId } : {}) });
      if (this.outputMeterActive) {
        this.beginOutputClear();
        this.sendEvent({ type: "output_audio_buffer.clear" });
      }
      if (!this.responseActive && !this.outputMeterActive) this.requestQueuedResponse();
    }, fadeMs);
  }

  private handleMessage(raw: unknown): void {
    if (this.closed || typeof raw !== "string") return;

    let event: WireEvent;
    try {
      event = JSON.parse(raw) as WireEvent;
    } catch {
      return;
    }
    if (import.meta.env.DEV && typeof event.session?.instructions === "string") {
      this.callbacks.onSessionInstructions?.(event.session.instructions);
    }
    if (event.session?.tools?.some(tool => tool.name === CHARACTER_TOOL_NAME)) {
      this.nativeCharacterEnabled = true;
    }

    // Out-of-band reaction responses share this data channel with audio, but
    // they are a completely separate lifecycle. Route them before the voice
    // switch so text analysis can never reset audio/transcript/phase state.
    const reactionRequest = this.reactionRequestForEvent(event);
    if (reactionRequest) {
      this.handleReactionEvent(event, reactionRequest);
      return;
    }
    const responseId = this.responseIdForEvent(event);
    const analysisKind = event.response?.metadata?.kind;
    if (analysisKind === REACTION_RESPONSE_KIND || analysisKind === SPEECH_PLAN_RESPONSE_KIND) {
      // A delayed analyzer may outlive its bounded request cache. Its created
      // or done events must never masquerade as a new audible response.
      if (responseId) this.retiredAnalysisResponses.add(responseId);
      return;
    }
    if (responseId && this.retiredAnalysisResponses.has(responseId)) return;
    this.emitTransportDiagnostic("receive", event);
    if (this.nativeCharacterEnabled && this.isVoiceLifecycleEvent(event)) {
      if (event.type === "response.created") {
        // IDs are assigned by the provider. Correlate its acknowledgement to
        // our reservation before any output may claim the new voice slot.
        if (!responseId || !this.awaitingVoiceResponse
          || event.response?.metadata?.request_id !== this.voiceResponseRequestId) return;
        this.awaitingVoiceResponse = false;
        if (this.handoffPending || this.responseInterrupted || this.outputClearPending) {
          // The user took the floor while creation was in flight. Bind the
          // old response only so cancel/done can retire it; never restart UI.
          this.activeVoiceResponseId = responseId;
          return;
        }
      } else if (!this.activeVoiceResponseId
        && !(event.type === "output_audio_buffer.cleared" && responseId === this.pendingOutputClearResponseId)) {
        return;
      }
    }
    // Keep one audible response's lifecycle isolated until its output buffer
    // has actually drained. Generation can finish before playback, and a
    // delayed/parallel response with another id must not reset the active
    // transcript, meter, phase, or response state. OOB analyzer events were
    // routed above, so this fence is only for voice lifecycle events.
    if (
      responseId
      && this.activeVoiceResponseId
      && responseId !== this.activeVoiceResponseId
      && this.isVoiceLifecycleEvent(event)
    ) return;
    // A cancelled response can finish after the next response has already
    // started. Realtime buffer events do not all carry an id, but when one is
    // present it is a reliable fence for generated text and lifecycle state.
    // Keep the expected clear acknowledgement flowing even if the cancelled
    // response id was retired by response.done first.
    if (
      responseId
      && this.retiredVoiceResponseIds.has(responseId)
      && !(
        event.type === "output_audio_buffer.cleared"
        && this.outputClearPending
        && this.pendingOutputClearResponseId === responseId
      )
    ) return;
    if (
      event.type === "response.created"
      && responseId
      && this.responseActive
      && this.activeVoiceResponseId
      && responseId !== this.activeVoiceResponseId
    ) return;
    const requestEventId = event.error?.event_id;
    if (event.type === "error" && requestEventId && /^(reaction-|speech-plan-)/u.test(requestEventId)) return;
    const isInputTranscription = event.type?.startsWith("conversation.item.input_audio_transcription.") ?? false;
    if (this.manualTurnDetection && isInputTranscription) {
      if (!event.item_id) return;
      const mappedGeneration = this.manualInputItems.get(event.item_id);
      if (mappedGeneration === undefined) {
        // The item id is assigned by the server, so transcription can beat the
        // committed acknowledgement. Buffer it until that ACK establishes the
        // generation instead of dropping the only semantic context for the turn.
        this.bufferManualTranscription(event);
        return;
      }
      if (mappedGeneration !== this.manualInputGeneration) return;
    }
    if (
      isInputTranscription
      && this.activeInputItemId && event.item_id && event.item_id !== this.activeInputItemId
    ) return;

    const error = realtimeErrorMessage(event as RealtimeServerEvent);
    if (error) {
      this.fail(error);
      return;
    }

    if (this.nativeCharacterEnabled && (this.handoffPending || this.responseInterrupted)) {
      if (event.type === "output_audio_buffer.started") {
        // Late playout still needs clearing, but cannot bring the old face,
        // caption, or speaking phase back after the user has taken the floor.
        this.outputMeterActive = true;
        this.sawOutputBufferEvents = true;
        this.responseHasAudio = true;
        if (this.responseInterrupted && !this.outputClearPending) {
          this.beginOutputClear();
          this.sendEvent({ type: "output_audio_buffer.clear" });
        }
        return;
      }
      if (event.type?.startsWith("response.output_") || event.type?.startsWith("response.function_call_arguments.")) return;
    }

    if (event.type === "response.function_call_arguments.done") {
      this.handleCharacterCall({ type: "function_call", name: event.name, call_id: event.call_id, arguments: event.arguments }, responseId);
      return;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      this.handleCharacterCall(event.item, responseId);
      return;
    }
    if (this.finishCharacterToolResponse(event)) return;
    if (this.nativeCharacterEnabled && event.type === "response.done"
      && !this.responseInterrupted && !this.handoffPending
      && !this.responseHasAudio && !this.generatedTranscript.trim()
      && !(event.response?.output?.length)) {
      // Some incomplete/empty provider turns have neither speech nor a tool.
      // There is no playback event coming to release "thinking" in that case.
      // Surface the failure instead of leaving a lifeless face indefinitely.
      this.fail("The voice returned no reply. Please try again.");
      return;
    }

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (!this.manualTurnDetection) this.beginUserInput(event.item_id ?? null);
        break;
      case "input_audio_buffer.speech_stopped":
        if (this.manualTurnDetection) break;
        // VAD stop events can arrive out of order when a new input item has
        // already started. Never let an old item end the current turn.
        if (this.activeInputItemId && event.item_id && event.item_id !== this.activeInputItemId) break;
        this.commitUserInput();
        break;
      case "input_audio_buffer.committed": {
        if (!this.manualTurnDetection) break;
        const commit = this.pendingManualCommits.shift();
        this.watchManualCommits();
        if (!commit || !event.item_id) break;
        this.manualInputItems.set(event.item_id, commit.generation);
        while (this.manualInputItems.size > 32) {
          this.manualInputItems.delete(this.manualInputItems.keys().next().value!);
        }
        if (commit.generation !== this.manualInputGeneration || this.userSpeechActive) {
          this.pendingManualTranscriptions.delete(event.item_id);
          break;
        }
        this.activeInputItemId = event.item_id;
        this.commitUserInput();
        this.replayManualTranscriptions(event.item_id, commit.generation);
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        // The voice model already has the committed audio. ASR is an
        // auxiliary signal for our captions/director, not a dependency that
        // may deadlock the next audible response.
        this.inputTranscriptComplete = true;
        this.inputAudioCommitted = true;
        this.inputTranscriptionFailed = true;
        // A failed transcript's partial prefix may omit a negation or
        // correction. Let the audio model reply, but do not guess a reaction.
        this.emitReactionDiagnostic({ state: "failed", turnId: this.pendingUserTurnId ?? this.latestReactionTurnId ?? "input", reason: "input_transcription_failed" });
        this.checkTalkOver();
        this.requestQueuedResponse();
        break;
      case "response.created":
        if (this.outputSilenceTimer !== null) window.clearTimeout(this.outputSilenceTimer);
        this.outputSilenceTimer = null;
        this.responseActive = true;
        this.responseHasAudio = false;
        this.sawOutputBufferEvents = false;
        this.outputPlaybackEnded = false;
        this.outputTemporarilyCleared = false;
        this.responseInterrupted = false;
        this.outputWasAudible = false;
        this.outputFirstAudibleAt = null;
        this.estimatedOutputDurationMs = null;
        this.outputFirstAudioContextTime = null;
        if (this.outputDrainTimer !== null) window.clearTimeout(this.outputDrainTimer);
        this.outputDrainTimer = null;
        this.outputQuietSince = null;
        this.pendingOutputBoundary = null;
        this.talkOver.reset();
        this.clearBargeInTimer();
        if (this.outputGain && this.outputContext) {
          const at = this.outputContext.currentTime;
          this.outputGain.gain.cancelScheduledValues(at);
          this.outputGain.gain.setValueAtTime(this.outputGain.gain.value, at);
          this.outputGain.gain.linearRampToValueAtTime(1, at + 0.06);
        }
        if (this.audioElement) this.audioElement.volume = 1;
        this.activeVoiceResponseId = this.responseIdForEvent(event);
        if (this.activeVoiceTurnId === null) this.activeVoiceTurnId = this.latestReactionTurnId;
        this.voiceResponseEnded = false;
        this.assistantContextRecorded = false;
        this.assistantContextEntry = null;
        this.outputLevel = 0;
        if (this.playbackPhaseTimer !== null) {
          window.clearTimeout(this.playbackPhaseTimer);
          this.playbackPhaseTimer = null;
        }
        this.resetAssistantTranscript();
        this.callbacks.onPhase("thinking");
        break;
      case "output_audio_buffer.started":
        // The real buffer lifecycle takes over from the RMS-only fallback.
        // A silence timer armed before this event must not later mark an
        // actively playing reply as listening or stop its caption clock.
        if (this.outputSilenceTimer !== null) window.clearTimeout(this.outputSilenceTimer);
        this.outputSilenceTimer = null;
        this.sawOutputBufferEvents = true;
        this.outputMeterActive = true;
        if (this.playbackPhaseTimer !== null) {
          window.clearTimeout(this.playbackPhaseTimer);
          this.playbackPhaseTimer = null;
        }
        this.responseHasAudio = true;
        this.outputPlaybackEnded = false;
        this.outputTemporarilyCleared = false;
        this.voiceResponseEnded = false;
        this.callbacks.onPhase("speaking");
        this.startTranscriptPlayback();
        break;
      case "response.output_audio.delta":
        if (!this.responseHasAudio) {
          this.responseHasAudio = true;
          this.callbacks.onPhase("speaking");
        }
        break;
      case "output_audio_buffer.stopped":
        this.sawOutputBufferEvents = true;
        this.finishOutputWhenDrained();
        break;
      case "output_audio_buffer.cleared":
        const clearResponseId = this.responseIdForEvent(event);
        if (!this.outputClearPending) {
          // WebRTC can clear its playout buffer on server VAD even when
          // interrupt_response=false keeps generation alive. A matching clear
          // is a real audio stop, not a spurious acknowledgement to ignore.
          // Uncorrelated/old clears must still never end the current turn.
          if (!clearResponseId || clearResponseId !== this.activeVoiceResponseId) break;
          this.outputTemporarilyCleared = true;
          this.sawOutputBufferEvents = true;
          this.outputMeterActive = false;
          this.outputLevel = 0;
          this.discardUnheardTranscript();
          this.callbacks.onAmplitude("output", 0);
          this.callbacks.onPhase("listening");
          if (!this.responseActive) this.finishUnsolicitedOutputClear();
          this.checkTalkOver();
          this.requestQueuedResponse();
          break;
        }
        if (
          this.pendingOutputClearResponseId
          && clearResponseId !== this.pendingOutputClearResponseId
        ) break;
        if (this.outputClearTimer !== null) window.clearTimeout(this.outputClearTimer);
        this.outputClearTimer = null;
        this.outputClearPending = false;
        this.pendingOutputClearResponseId = null;
        if (this.outputDrainTimer !== null) window.clearTimeout(this.outputDrainTimer);
        this.outputDrainTimer = null;
        this.outputPlaybackEnded = true;
        this.voiceResponseEnded = true;
        this.responseInterrupted = true;
        this.discardUnheardTranscript();
        this.sawOutputBufferEvents = true;
        this.outputMeterActive = false;
        this.clearBargeInTimer();
        // Playout can acknowledge the clear before generation acknowledges
        // cancellation. Keep the response correlated until both have ended;
        // retiring it here would fence out the only response.done that can
        // release responseActive and leave the newest user turn queued forever.
        if (!this.responseActive) {
          this.retireVoiceResponseId(this.activeVoiceResponseId);
          this.activeVoiceResponseId = null;
        }
        if (this.queuedUserTurn) this.requestQueuedResponse();
        else this.callbacks.onPhase("listening");
        break;
      case "response.output_audio.done":
        break;
      case "response.done":
        this.responseActive = false;
        if (this.outputTemporarilyCleared) {
          this.finishUnsolicitedOutputClear();
          this.requestQueuedResponse();
          break;
        }
        {
          const audioTokens = event.response?.usage?.output_token_details?.audio_tokens;
          // OpenAI documents approximately 50 ms per assistant audio token.
          // This is a duration correction, not a claim of word timestamps.
          if (typeof audioTokens === "number" && Number.isFinite(audioTokens) && audioTokens > 0) {
            this.estimatedOutputDurationMs = Math.min(120_000, audioTokens * 50);
            this.timeline.setDuration(this.estimatedOutputDurationMs, this.playbackElapsedMs());
          }
        }
        if (!this.responseInterrupted && this.generatedTranscript.trim()) {
          if (this.assistantContextEntry) this.assistantContextEntry.text = this.generatedTranscript.trim();
          else if (!this.assistantContextRecorded) this.assistantContextEntry = this.recordContext("assistant", this.generatedTranscript);
          this.assistantContextRecorded = true;
        }
        this.requestQueuedResponse();
        break;
    }

    const userDelta = inputTranscriptDelta(event);
    if (userDelta) {
      this.userTranscript += userDelta;
      // A late ASR delta can extend a completed “yeah” into a real turn.
      // Re-open queuing in that case instead of letting the delayed VAD stop
      // discard the substantive continuation.
      if (this.inputWasBackchannel && !isBackchannel(this.userTranscript)) {
        this.inputWasBackchannel = false;
      }
      this.callbacks.onUserTranscriptDelta(userDelta);
      if (this.inputTurnOverlapped) this.checkTalkOver();
    }

    const finalUserTranscript = completedTranscript(event, "input");
    if (finalUserTranscript !== null) {
      this.inputTranscriptComplete = true;
      this.inputAudioCommitted = true;
      this.inputTranscriptionFailed = false;
      const missing = missingTranscriptSuffix(this.userTranscript, finalUserTranscript);
      if (missing) {
        this.userTranscript += missing;
        this.callbacks.onUserTranscriptDelta(missing);
      } else if (finalUserTranscript && finalUserTranscript !== this.userTranscript) {
        this.userTranscript = finalUserTranscript;
        this.callbacks.onUserTranscriptReset();
        this.callbacks.onUserTranscriptDelta(finalUserTranscript);
      }
      const finalText = this.userTranscript || finalUserTranscript;
      if (this.inputTurnOverlapped && isBackchannel(finalText)) {
        this.queuedUserTurn = false;
        this.pendingUserTurnId = null;
        this.inputWasBackchannel = true;
        this.finalizedUserTurn = true;
        this.finalizedUserText = finalText;
      } else {
        this.inputWasBackchannel = false;
        this.finalizeUserTurn(finalText);
      }
      if (this.inputTurnOverlapped) this.checkTalkOver();
      this.requestQueuedResponse();
    }

    const delta = transcriptDelta(event);
    if (delta && !this.responseInterrupted) {
      const addition = this.outputTranscriptStream.append(delta, event.item_id);
      this.generatedTranscript += addition;
      this.transcriptBuffer += addition;
      this.assistantTranscriptComplete = false;
      this.timeline.updateText(this.generatedTranscript, this.assistantTranscriptComplete);
      this.updateCaptionPlan();
      this.prepareFastSpeechCues();
      this.responseHasAudio = true;
      this.maybeStartSpeechPlanAnalysis();
      if (this.outputPlaybackEnded) this.flushTranscriptPlayback();
      else if (this.outputMeterActive) this.startTranscriptPlayback();
    }

    const finalAssistantTranscript = completedTranscript(event, "output");
    if (finalAssistantTranscript !== null && !this.responseInterrupted) {
      this.assistantTranscriptComplete = true;
      const missing = this.outputTranscriptStream.append(finalAssistantTranscript, event.item_id, true);
      if (missing) {
        this.generatedTranscript += missing;
        this.transcriptBuffer += missing;
      }
      this.timeline.updateText(this.generatedTranscript, true);
      this.updateCaptionPlan();
      this.prepareFastSpeechCues();
      this.maybeStartSpeechPlanAnalysis();
      if (this.outputPlaybackEnded) this.flushTranscriptPlayback();
      else if (this.outputMeterActive) this.startTranscriptPlayback();
    }

    // response.done can arrive after the transcript is fully generated but
    // before its audio buffer has stopped. Give a final bounded remainder one
    // non-blocking plan request while there is still an audible window.
    if (event.type === "response.done" && !this.responseInterrupted) {
      this.assistantTranscriptComplete = true;
      this.timeline.updateText(this.generatedTranscript, true);
      this.maybeStartSpeechPlanAnalysis(true);
    }

    if (event.type === "response.done" && !this.responseInterrupted && this.responseHasAudio && !this.sawOutputBufferEvents) {
      if (this.playbackPhaseTimer !== null) window.clearTimeout(this.playbackPhaseTimer);
      this.playbackPhaseTimer = window.setTimeout(() => {
        this.playbackPhaseTimer = null;
        if (this.peer) {
          this.voiceResponseEnded = true;
          this.flushTranscriptPlayback();
          if (this.queuedUserTurn) this.requestQueuedResponse();
          else this.callbacks.onPhase("listening");
        }
      }, 1200);
    }

  }

  private finishOutputWhenDrained(): void {
    if (this.outputDrainTimer !== null) window.clearTimeout(this.outputDrainTimer);
    const started = this.now();
    const finish = () => {
      this.outputDrainTimer = null;
      if (this.closed || this.responseInterrupted) return;
      const localClockAvailable = this.outputContext?.state === "running" && this.outputWasAudible;
      const quietFor = this.outputQuietSince === null ? 0 : this.now() - this.outputQuietSince;
      // The server's stop event may precede samples leaving the local device.
      // Let the measured tail drain; keep the wait bounded if a meter fails.
      if (localClockAvailable && quietFor < 120 && this.now() - started < 700) {
        this.outputDrainTimer = window.setTimeout(finish, 16);
        return;
      }
      this.outputPlaybackEnded = true;
      this.voiceResponseEnded = true;
      this.flushTranscriptPlayback();
      this.outputMeterActive = false;
      this.clearBargeInTimer();
      this.retireVoiceResponseId(this.activeVoiceResponseId);
      this.activeVoiceResponseId = null;
      if (this.queuedUserTurn) this.requestQueuedResponse();
      else this.callbacks.onPhase("listening");
    };
    finish();
  }

  private finishUnsolicitedOutputClear(): void {
    this.outputTemporarilyCleared = false;
    this.outputPlaybackEnded = true;
    this.voiceResponseEnded = true;
    this.responseInterrupted = true;
    this.outputMeterActive = false;
    this.discardUnheardTranscript();
    if (this.assistantContextEntry) {
      this.assistantContextEntry.text = this.presentedAssistantTranscript.trim();
      if (!this.assistantContextEntry.text) {
        this.recentContext = this.recentContext.filter((entry) => entry !== this.assistantContextEntry);
      }
    }
    this.retireVoiceResponseId(this.activeVoiceResponseId);
    this.activeVoiceResponseId = null;
    this.clearBargeInTimer();
  }

  private async playRemoteAudio(): Promise<void> {
    const audio = this.audioElement;
    const epoch = this.connectionEpoch;
    if (this.closed || !audio || !audio.paused) return;
    try {
      await audio.play();
      if (this.closed || this.connectionEpoch !== epoch) return;
      if (this.playbackWarningTimer !== null) {
        window.clearTimeout(this.playbackWarningTimer);
        this.playbackWarningTimer = null;
      }
    } catch (error) {
      if (this.closed || this.connectionEpoch !== epoch) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.playbackWarningTimer !== null) window.clearTimeout(this.playbackWarningTimer);
      this.playbackWarningTimer = window.setTimeout(() => {
        if (!this.closed && this.connectionEpoch === epoch && audio.paused) {
          this.callbacks.onError("Speaker playback was blocked. Allow sound for this site, then start again.");
        }
      }, 400);
    }
  }

  private fail(message: string): void {
    this.callbacks.onError(message);
    this.close(false);
    this.callbacks.onPhase("error");
  }

  private primeAudioOutput(): void {
    try {
      const context = new window.AudioContext();
      this.outputContext = context;
      this.contexts.push(context);

      const silent = context.createBufferSource();
      silent.buffer = context.createBuffer(1, 1, context.sampleRate);
      silent.connect(context.destination);
      silent.start();
      if (context.state === "suspended") void context.resume();
    } catch {
      this.outputContext = null;
    }
  }

  private createSyntheticInput(): MediaStream {
    const context = new window.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    this.contexts.push(context);
    return destination.stream;
  }

  private startMeter(
    stream: MediaStream,
    source: MeterSource,
    suppliedContext?: AudioContext,
    routeToSpeakers = false,
  ): void {
    const AudioContextClass = window.AudioContext;
    const context = suppliedContext ?? new AudioContextClass();
    if (context.state === "suspended") void context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.76;
    const streamSource = context.createMediaStreamSource(stream);
    streamSource.connect(analyser);
    // The 256-sample meter above only sees ~5 ms of each frame, which is
    // fine for audibility but misses most syllables. The face gets its own
    // gap-free tap of the voice for beat detection.
    const voiceAnalyser = source === "output" ? context.createAnalyser() : null;
    if (voiceAnalyser) {
      voiceAnalyser.fftSize = 2048;
      voiceAnalyser.smoothingTimeConstant = 0;
      streamSource.connect(voiceAnalyser);
    }
    const voiceSamples = voiceAnalyser ? new Float32Array(voiceAnalyser.fftSize) : null;
    const voiceBeats = new VoiceBeatDetector();
    const heardBeats = new HeardDelay<VoiceBeatState>({ level: 0, syllableTick: 0, strength: 0, syllableAtMs: null });
    const heardLevel = new HeardDelay(0);
    let lastVoiceTime: number | null = null;
    if (routeToSpeakers) {
      const gain = context.createGain();
      analyser.connect(gain);
      gain.connect(context.destination);
      this.outputGain = gain;
    }
    const samples = new Uint8Array(analyser.fftSize);
    let lastEmission = 0;
    let smoothed = 0;
    if (!this.contexts.includes(context)) this.contexts.push(context);

    const sample = (time: number) => {
      if (this.closed) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      if (source === "output" && this.audioElement?.dataset) {
        this.audioElement.dataset.contextState = context.state;
        this.audioElement.dataset.outputRms = rms.toFixed(5);
        this.audioElement.dataset.meterTime = String(Math.round(time));
      }
      const target = Math.min(1, rms * 5.5);
      smoothed += (target - smoothed) * (target > smoothed ? 0.34 : 0.18);
      if (source === "output") {
        this.outputLevel = smoothed;
        if (smoothed > OUTPUT_AUDIBLE_THRESHOLD) {
          this.outputWasAudible = true;
          this.outputFirstAudibleAt ??= this.now();
          this.outputFirstAudioContextTime ??= context.currentTime;
          this.outputQuietSince = null;
        } else if (this.outputQuietSince === null) {
          this.outputQuietSince = this.now();
        }
        if (smoothed > OUTPUT_AUDIBLE_THRESHOLD && this.transcriptWaitingForAudio) {
          this.startTranscriptPlayback();
        }
        if (this.outputWasAudible) this.timeline.observeAudio?.(this.playbackElapsedMs(), smoothed > OUTPUT_AUDIBLE_THRESHOLD);
      } else {
        this.inputLevel = smoothed;
        this.processLocalInput(rms, time);
        if (import.meta.env.DEV && this.audioElement?.dataset) {
          this.audioElement.dataset.inputRms = rms.toFixed(5);
          this.audioElement.dataset.localTurnState = this.userSpeechActive ? "speaking" : "quiet";
          this.audioElement.dataset.inputMode = this.manualTurnDetection ? "client" : "provider";
        }
      }
      if (source === "output" && !this.sawOutputBufferEvents) {
        if (smoothed > OUTPUT_AUDIBLE_THRESHOLD) {
          if (this.outputSilenceTimer !== null) {
            window.clearTimeout(this.outputSilenceTimer);
            this.outputSilenceTimer = null;
          }
          if (!this.outputMeterActive) {
            this.outputMeterActive = true;
            this.callbacks.onPhase("speaking");
            this.startTranscriptPlayback();
          }
        } else if (this.outputMeterActive && this.outputSilenceTimer === null) {
          const responseId = this.activeVoiceResponseId;
          const epoch = this.connectionEpoch;
          this.outputSilenceTimer = window.setTimeout(() => {
            this.outputSilenceTimer = null;
            if (this.closed || epoch !== this.connectionEpoch || this.sawOutputBufferEvents
              || responseId !== this.activeVoiceResponseId) return;
            this.outputMeterActive = false;
            this.flushTranscriptPlayback();
            if (this.peer) this.callbacks.onPhase("listening");
          }, 900);
        }
      }
      // The analysers read samples as they enter the graph; the listener
      // hears them one output latency later. Hold face-facing values back
      // by that much (less the frame the paint itself takes).
      const heardDelay = source === "output" ? Math.max(0, outputDelayMs(context) - 16) : 0;
      const contextMs = context.currentTime * 1000;
      if (voiceAnalyser && voiceSamples) {
        const fresh = lastVoiceTime === null
          ? voiceSamples.length
          : Math.round((context.currentTime - lastVoiceTime) * context.sampleRate);
        lastVoiceTime = context.currentTime;
        if (fresh > 0) {
          voiceAnalyser.getFloatTimeDomainData(voiceSamples);
          const count = Math.min(voiceSamples.length, fresh);
          const beat = voiceBeats.push(voiceSamples.subarray(voiceSamples.length - count), context.sampleRate, contextMs);
          const shown = this.responseInterrupted ? { ...beat, level: 0 } : beat;
          this.callbacks.onVoiceBeat?.(heardBeats.push(shown, contextMs, heardDelay));
        }
      }
      if (time - lastEmission >= 16) {
        const amplitude = source === "output" && this.responseInterrupted ? 0 : smoothed;
        this.callbacks.onAmplitude(source, source === "output" ? heardLevel.push(amplitude, contextMs, heardDelay) : amplitude);
        if (this.talkOver.pending) this.checkTalkOver();
        lastEmission = time;
      }
    };
    this.meterCleanups.push(startFrameLoop(sample));
  }

  private resetAssistantTranscript(): void {
    if (this.transcriptPlaybackTimer !== null) window.clearTimeout(this.transcriptPlaybackTimer);
    this.transcriptPlaybackTimer = null;
    this.transcriptBuffer = "";
    this.generatedTranscript = "";
    this.outputTranscriptStream.reset();
    this.presentedAssistantTranscript = "";
    this.transcriptCanPlay = false;
    this.transcriptWaitingForAudio = false;
    this.pendingSpeechCues = [];
    this.fastSpeechCues.clear();
    this.authoredSpeechStarts.clear();
    this.lateContextRefinedStarts.clear();
    this.speechPlanCoveredChars = 0;
    this.speechPlanRequestedThrough = 0;
    this.speechPlanRequestActive = false;
    this.speechPlanRequestId = null;
    this.emittedSpeechTurns.clear();
    this.assistantTranscriptComplete = false;
    this.playbackWordTick = 0;
    this.playbackPhraseTick = 0;
    this.previousWordEndedPhrase = false;
    this.pendingOutputBoundary = null;
    this.timeline.reset();
    this.captionPlanner.reset();
    this.captionPlan = { text: "", breaks: [0] };
    this.authoredCaptionBreaks.clear();
    this.callbacks.onCaptionPlan?.(this.captionPlan);
    this.callbacks.onTranscriptReset();
  }

  private startTranscriptPlayback(): void {
    this.transcriptCanPlay = true;
    if (this.transcriptPlaybackTimer !== null) return;
    if (!this.outputWasAudible && this.outputLevel <= OUTPUT_AUDIBLE_THRESHOLD && !this.outputPlaybackEnded) {
      this.transcriptWaitingForAudio = true;
      return;
    }
    this.transcriptWaitingForAudio = false;
    this.outputWasAudible = true;
    this.outputFirstAudibleAt ??= this.now();
    if (this.outputContext) this.outputFirstAudioContextTime ??= this.outputContext.currentTime;
    const source = this.generatedTranscript || this.presentedAssistantTranscript + this.transcriptBuffer;
    this.timeline.updateText(source, this.assistantTranscriptComplete);
    this.updateCaptionPlan();

    const tick = () => {
      this.transcriptPlaybackTimer = null;
      if (!this.transcriptCanPlay || this.closed || this.responseInterrupted) return;
      this.presentTimelineWords();
      this.emitAvailableSpeechCues();
      // This is only a repaint heartbeat. Deadlines come from elapsed audio
      // time, so a delayed callback never adds another word-length wait.
      this.transcriptPlaybackTimer = window.setTimeout(tick, 16);
    };
    tick();
  }

  private presentTimelineWords(leadMs?: number, emitActing = true): void {
    const elapsed = this.playbackElapsedMs();
    const due = this.timeline.advance(elapsed, leadMs);
    if (!due.length) return;
    const source = this.generatedTranscript || this.presentedAssistantTranscript + this.transcriptBuffer;
    const end = due.at(-1)!.charEnd;
    const delta = source.slice(this.presentedAssistantTranscript.length, end);
    this.presentedAssistantTranscript = source.slice(0, end);
    this.transcriptBuffer = source.slice(end);
    for (const word of due) {
      const punctuation = speechPunctuation(word.text);
      const startsCaption = word.index > 0 && this.captionPlan.breaks.includes(word.index);
      if (this.previousWordEndedPhrase || startsCaption) this.playbackPhraseTick += 1;
      this.previousWordEndedPhrase = punctuation !== "none" || /\n/u.test(word.chunk);
      this.playbackWordTick = word.index + 1;
      if (emitActing) this.callbacks.onPlaybackWord?.({
        word: word.text, wordTick: this.playbackWordTick,
        phraseTick: this.playbackPhraseTick, punctuation, atMs: word.startMs,
      });
      if (punctuation !== "none" && word.endMs >= elapsed) {
        const candidate: { at: number; boundary: "phrase" | "sentence" } = {
          at: this.now() + Math.max(0, word.endMs - elapsed),
          boundary: punctuation === "comma" ? "phrase" : "sentence",
        };
        if (!this.pendingOutputBoundary || candidate.at < this.pendingOutputBoundary.at) {
          this.pendingOutputBoundary = candidate;
        }
      }
    }
    this.updateCaptionPlan();
    if (delta) this.callbacks.onTranscriptDelta(delta);
  }

  private flushTranscriptPlayback(): void {
    if (this.transcriptPlaybackTimer !== null) window.clearTimeout(this.transcriptPlaybackTimer);
    this.transcriptPlaybackTimer = null;
    this.transcriptWaitingForAudio = false;
    if (this.outputWasAudible) {
      // Reconcile deadlines at local playback completion, not generation.done.
      // Never spill an unspoken paragraph into the bubble after audio ends.
      const source = this.generatedTranscript || this.presentedAssistantTranscript + this.transcriptBuffer;
      this.timeline.updateText(source, true);
      this.presentTimelineWords(120, false);
      const remaining = captionWords(this.transcriptBuffer);
      const currentStart = [...this.captionPlan.breaks].reverse().find((at) => at < this.playbackWordTick) ?? 0;
      const nextBreak = this.captionPlan.breaks.find((at) => at > currentStart);
      if (remaining.length > 0 && remaining.length <= 2 && nextBreak === undefined) {
        // A terminal word such as "side" belongs to this same completed
        // thought. Retain it even if the approximate clock was a frame late.
        this.presentedAssistantTranscript += this.transcriptBuffer;
        this.callbacks.onTranscriptDelta(this.transcriptBuffer);
      }
    }
    this.transcriptBuffer = "";
    this.transcriptCanPlay = false;
  }

  private discardUnheardTranscript(): void {
    if (this.transcriptPlaybackTimer !== null) window.clearTimeout(this.transcriptPlaybackTimer);
    this.transcriptPlaybackTimer = null;
    this.transcriptWaitingForAudio = false;
    this.transcriptBuffer = "";
    this.transcriptCanPlay = false;
    this.pendingSpeechCues = [];
  }
}
