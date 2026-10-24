/**
 * A small, deterministic policy for deciding when a user's talk-over should
 * hand the audio turn back to them.
 *
 * This is intentionally separate from the Realtime transport. The transport
 * owns sending `response.cancel` and `output_audio_buffer.clear`; this module
 * only decides whether the moment is a good one. Call `update` for each VAD,
 * transcription, playback-boundary, and (while an overlap is pending) meter
 * update. `reset` is required when a conversation is ended or a new assistant
 * response starts after the previous overlap has been resolved.
 *
 * The policy does not try to reproduce the ChatGPT website's private client.
 * It uses the public signals available to an app: actual input activity,
 * streaming/complete user transcription, semantic pauses, and safe output
 * phrase boundaries. A bounded safety deadline prevents an assistant that
 * never yields from holding the turn forever.
 */

export type TalkOverBoundary = "word" | "phrase" | "sentence";

export type TalkOverReason =
  | "assistant_inactive"
  | "no_user_activity"
  | "backchannel"
  | "awaiting_transcript"
  | "awaiting_pause"
  | "awaiting_output_boundary"
  | "output_quiet"
  | "output_boundary"
  | "safety_handoff"
  | "explicit_stop"
  | "stop_intent"
  | "already_handed_off";

export type TalkOverSnapshot = {
  /** A monotonic timestamp supplied by the caller. */
  nowMs: number;
  /** True while the server-side VAD considers the user to be speaking. */
  userSpeechActive: boolean;
  /** Optional local input meter in the same 0..1-ish scale as the app meter. */
  inputLevel?: number;
  /** The cumulative transcript for the current user turn, not a delta. */
  userTranscript?: string | null;
  /** Whether the current transcript is the completed input transcription. */
  userTranscriptComplete?: boolean;
  /**
   * The input audio was committed, but its auxiliary transcript may still be
   * unavailable. This is a turn-taking signal only; callers must never infer
   * a mood or reaction from it.
   */
  userInputCommitted?: boolean;
  /** A semantic/VAD pause signal. It is trusted only once input is quiet. */
  userPaused?: boolean;
  /** True after at least a short (for example, 160 ms) assistant-output gap. */
  outputQuiet?: boolean;
  /** The model is still generating its current response. */
  assistantGenerating: boolean;
  /** Audible assistant output is still buffered/playing. */
  assistantAudioPlaying: boolean;
  /** A known safe point in the assistant's currently playing output. */
  outputBoundary?: TalkOverBoundary;
  /**
   * Absolute monotonic time of the next known phrase/sentence boundary. The
   * caller should provide this from its playback timeline; it is used to wait
   * through a short, known remainder instead of cutting at the safety wall.
   */
  outputBoundaryAt?: number;
  /** User explicitly pressed End conversation. */
  explicitStop?: boolean;
};

export type TalkOverDecision = {
  handoff: boolean;
  reason: TalkOverReason;
  /** A transport/UI layer may use this hint for a short local fade. */
  fadeMs?: number;
  /** Suggested time for the caller to poll again while waiting. */
  nextCheckAt?: number;
};

export type TalkOverPolicy = {
  /** Ignore an overlap shorter than this, even when its transcript is clear. */
  minimumOverlapMs: number;
  /**
   * Treat an untranscribed overlap as sustained only after this much
   * uninterrupted input activity. Short acknowledgements must not inherit the
   * faster handoff path merely because ASR is late.
   */
  unknownSustainedInputMs: number;
  /**
   * Absolute fallback for a sustained, still-untranscribed overlap. A known
   * output gap or phrase boundary can hand off sooner; this keeps missing ASR
   * from holding the old response indefinitely.
   */
  unknownSustainedSafetyMs: number;
  /**
   * Give a transcript-backed topic change this long to find a phrase boundary.
   *
   * This is deliberately short: once the user has supplied real content, an
   * old answer should finish one small audible thought and yield instead of
   * continuing for several seconds. A custom policy can still tune this for a
   * slower transport or a different product voice.
   */
  substantiveSafetyMs: number;
  /** Give a short acknowledgement/no-transcript overlap a little longer. */
  backchannelSafetyMs: number;
  /** Input amplitude above this is treated as active when VAD is catching up. */
  inputActivityThreshold: number;
  /** Fade hint for an intentional, phrase-aligned handoff. */
  naturalFadeMs: number;
  /** Fade hint for the finite safety fallback. */
  safetyFadeMs: number;
  /**
   * How far past the safety wall a known upcoming boundary may be awaited.
   * This is intentionally finite so a bad timeline cannot hold the turn.
   */
  boundaryGraceMs: number;
};

export const DEFAULT_TALK_OVER_POLICY: TalkOverPolicy = {
  minimumOverlapMs: 420,
  unknownSustainedInputMs: 1_500,
  unknownSustainedSafetyMs: 2_200,
  // The fallback is a guardrail, not the normal handoff path. In normal use a
  // phrase/sentence boundary or a measured output gap wins first; 1.2 s keeps
  // a missing boundary from letting the old topic ramble on indefinitely.
  substantiveSafetyMs: 1_200,
  backchannelSafetyMs: 4_200,
  inputActivityThreshold: 0.035,
  naturalFadeMs: 140,
  safetyFadeMs: 180,
  boundaryGraceMs: 2_000,
};

type Overlap = {
  startedAt: number;
  lastInputSampleAt: number;
  /** Total input-active time observed for this overlap. */
  activeInputMs: number;
  /** Current uninterrupted input-active run. */
  activeInputStreakMs: number;
  /** Latched once a genuinely sustained run has been observed. */
  sustainedInputObserved: boolean;
  inputWasActive: boolean;
  transcript: string;
  transcriptComplete: boolean;
  transcriptKind: "unknown" | "backchannel" | "substantive";
  inputCommitted: boolean;
  hasClauseBoundary: boolean;
  stopIntent: boolean;
  userPaused: boolean;
  handoffEmitted: boolean;
};

const BACKCHANNEL_WORDS = new Set([
  "yeah",
  "yea",
  "yep",
  "yup",
  "mm",
  "mmm",
  "mhm",
  "mmhm",
  "mm-hm",
  "mm-hmm",
  "uh huh",
  "uh-huh",
  "okay",
  "ok",
  "alright",
  "right",
  "sure",
  "got it",
  "i see",
  "thanks",
  "thank you",
]);

const MAX_BACKCHANNEL_WORDS = 3;
const MAX_BACKCHANNEL_CHARS = 32;
const BACKCHANNEL_TOKENS = new Set([
  "yeah",
  "yea",
  "yep",
  "yup",
  "mm",
  "mmm",
  "mhm",
  "mmhm",
  "mm-hm",
  "mm-hmm",
  "uh",
  "huh",
  "okay",
  "ok",
  "alright",
  "right",
  "sure",
  "thanks",
  "thank",
  "you",
]);

const STOP_INTENT_PHRASES = new Set([
  "stop",
  "hold on",
  "wait",
  "wait a second",
  "wait a sec",
  "hang on",
  "hold up",
  "pause",
  "one sec",
  "one second",
  "give me a sec",
  "give me a second",
]);

function finiteTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(fallback, value) : fallback;
}

function finiteLevel(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function normalizeTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Conservative backchannel detection. A bare “yeah” should not cut a voice
 * response, while “yeah, but that is not what I meant” must become
 * substantive as soon as its extra words arrive.
 */
export function isBackchannel(text: string): boolean {
  const normalized = normalizeTranscript(text);
  if (!normalized || normalized.length > MAX_BACKCHANNEL_CHARS) return false;
  const words = normalized.split(" ");
  if (words.length > MAX_BACKCHANNEL_WORDS) return false;
  return BACKCHANNEL_WORDS.has(normalized) || words.every((word) => BACKCHANNEL_TOKENS.has(word));
}

/**
 * Detect an explicit request for the assistant to stop or hold. This is
 * intentionally narrower than “substantive”: ordinary corrections such as
 * “no, that is wrong” should wait for a natural output boundary.
 */
export function isStopIntent(text: string): boolean {
  const normalized = normalizeTranscript(text);
  if (!normalized || normalized.length > 96) return false;
  if (STOP_INTENT_PHRASES.has(normalized)) return true;
  // “Wait, I need to correct that” is often just a discourse marker. Treat
  // wait/pause as urgent only when the rest explicitly asks for time.
  return /^(?:stop|hold on|hang on|hold up)(?:\s|$)/u.test(normalized)
    || /^(?:wait|pause)\s+(?:a\s+)?(?:second|sec|moment|minute|please)(?:\s|$)/u.test(normalized)
    || /^please\s+(?:stop|hold on|hang on|hold up)(?:\s|$)/u.test(normalized);
}

function hasClauseBoundary(text: string): boolean {
  return /[.!?](?:["'”’)]*)?\s*$/u.test(text.trim());
}

function substantiveKind(text: string): "unknown" | "backchannel" | "substantive" {
  const normalized = text.trim();
  if (!normalized) return "unknown";
  return isBackchannel(normalized) ? "backchannel" : "substantive";
}

function noHandoff(reason: TalkOverReason, nextCheckAt?: number): TalkOverDecision {
  return nextCheckAt === undefined ? { handoff: false, reason } : { handoff: false, reason, nextCheckAt };
}

/**
 * Stateful but pure-to-the-outside controller. It has no timers, DOM, audio,
 * or network dependency, so the caller can drive it from either browser
 * events or deterministic tests.
 */
export class TalkOverController {
  private readonly policy: TalkOverPolicy;
  private overlap: Overlap | null = null;
  private previousAssistantActive = false;
  private previousNowMs = 0;

  constructor(policy: Partial<TalkOverPolicy> = {}) {
    this.policy = {
      ...DEFAULT_TALK_OVER_POLICY,
      ...policy,
      // Keep the existing backchannelSafetyMs override meaningful for callers
      // that tune the controller without knowing about the sustained-unknown
      // path. The default still shortens the normal 4.2 s unknown fallback.
      ...(policy.unknownSustainedSafetyMs === undefined
        ? { unknownSustainedSafetyMs: Math.min(DEFAULT_TALK_OVER_POLICY.unknownSustainedSafetyMs, policy.backchannelSafetyMs ?? DEFAULT_TALK_OVER_POLICY.backchannelSafetyMs) }
        : {}),
    };
  }

  /** Discard any pending overlap, including a handoff already emitted. */
  reset(): void {
    this.overlap = null;
    this.previousAssistantActive = false;
    this.previousNowMs = 0;
  }

  /** A snapshot of the pending state, useful for a transport's debug panel. */
  get pending(): boolean {
    return this.overlap !== null;
  }

  update(snapshot: TalkOverSnapshot): TalkOverDecision {
    const nowMs = finiteTime(snapshot.nowMs, this.previousNowMs);
    this.previousNowMs = nowMs;

    const assistantActive = snapshot.assistantGenerating || snapshot.assistantAudioPlaying;
    const level = finiteLevel(snapshot.inputLevel);
    const levelActive = level !== null && level >= this.policy.inputActivityThreshold;
    // A local meter can briefly remain hot after VAD says stopped. Once an
    // overlap exists, keep treating it as active until the meter is quiet too.
    const inputActive = snapshot.userSpeechActive || (this.overlap !== null && levelActive);

    if (snapshot.explicitStop) {
      if (!assistantActive) return noHandoff("assistant_inactive");
      if (this.overlap?.handoffEmitted) return noHandoff("already_handed_off");
      this.ensureOverlap(nowMs, inputActive);
      return this.emitHandoff("explicit_stop", this.policy.naturalFadeMs);
    }

    // A response that ended naturally should not let an old overlap cancel the
    // next response. Keep an active user overlap only while the input is still
    // genuinely active; otherwise it is complete and can be forgotten.
    if (!assistantActive && this.previousAssistantActive && !inputActive) {
      this.overlap = null;
    }
    this.previousAssistantActive = assistantActive;

    if (!assistantActive) {
      if (!inputActive) this.overlap = null;
      return noHandoff("assistant_inactive");
    }

    if (!inputActive && this.overlap === null) return noHandoff("no_user_activity");
    const overlap = this.ensureOverlap(nowMs, inputActive);

    if (snapshot.userTranscript !== undefined && snapshot.userTranscript !== null) {
      const transcript = snapshot.userTranscript.trim();
      // Realtime transcription is cumulative. Never replace useful text with
      // an empty late delta while the VAD event stream catches up.
      if (transcript || !overlap.transcript) overlap.transcript = transcript;
      overlap.transcriptKind = substantiveKind(overlap.transcript);
      overlap.transcriptComplete = overlap.transcriptComplete || Boolean(snapshot.userTranscriptComplete);
      overlap.hasClauseBoundary = hasClauseBoundary(overlap.transcript);
      overlap.stopIntent = overlap.stopIntent || isStopIntent(overlap.transcript);
    } else if (snapshot.userTranscriptComplete) {
      overlap.transcriptComplete = true;
    }
    if (snapshot.userInputCommitted) overlap.inputCommitted = true;

    const previousInputActive = overlap.inputWasActive;
    const inputDeltaMs = Math.max(0, nowMs - overlap.lastInputSampleAt);
    if (previousInputActive) {
      overlap.activeInputMs += inputDeltaMs;
      overlap.activeInputStreakMs += inputDeltaMs;
    }
    if (inputActive) {
      // A pause is a moment, not a permanent property of the overlap. If the
      // user resumes speaking, later boundaries must be eligible again.
      if (!previousInputActive) overlap.activeInputStreakMs = 0;
      if (overlap.activeInputStreakMs >= this.policy.unknownSustainedInputMs) {
        overlap.sustainedInputObserved = true;
      }
      overlap.userPaused = false;
    } else {
      if (overlap.activeInputStreakMs >= this.policy.unknownSustainedInputMs) {
        overlap.sustainedInputObserved = true;
      }
      overlap.activeInputStreakMs = 0;
      overlap.userPaused = true;
      if (snapshot.userPaused && !levelActive) overlap.userPaused = true;
    }
    overlap.inputWasActive = inputActive;
    overlap.lastInputSampleAt = nowMs;

    // A stop event can be delayed relative to the transcript. This captures a
    // real transition to quiet, but does not mistake a hot meter for a pause.
    const crossedIntoQuiet = previousInputActive && !inputActive;
    const naturalPause = overlap.userPaused || crossedIntoQuiet;

    if (overlap.handoffEmitted) return noHandoff("already_handed_off");

    const elapsed = Math.max(0, nowMs - overlap.startedAt);
    // A committed audio item with failed auxiliary ASR is still a real turn,
    // but it has no trustworthy text for reactions. The transport can use this
    // classification to hand audio back on the bounded substantive path while
    // keeping the director/reaction pipeline transcript-only.
    const kind = overlap.transcriptKind === "unknown"
      && overlap.inputCommitted
      && overlap.transcriptComplete
      ? "substantive"
      : overlap.transcriptKind;
    // An explicit transcript request is the one user signal allowed to
    // override the normal phrase-boundary wait.
    if (overlap.stopIntent) return this.emitHandoff("stop_intent", this.policy.naturalFadeMs);

    if (kind === "backchannel") {
      // Keep “yeah”, “mhm”, etc. from cutting the assistant. Once the
      // backchannel is quiet/completed, there must be no latent cancellation
      // timer; only genuinely sustained input is eligible for the fallback.
      if (!inputActive || overlap.userPaused) return noHandoff("backchannel");
      if (elapsed >= this.policy.backchannelSafetyMs) {
        return this.emitHandoff("safety_handoff", this.policy.safetyFadeMs);
      }
      return noHandoff("backchannel", nowMs + this.policy.backchannelSafetyMs - elapsed);
    }

    if (kind === "unknown") {
      const sustained = overlap.sustainedInputObserved;
      const safetyMs = sustained
        ? Math.max(this.policy.unknownSustainedInputMs, this.policy.unknownSustainedSafetyMs)
        : this.policy.backchannelSafetyMs;
      const safetyAt = overlap.startedAt + safetyMs;
      // A committed audio item with no usable transcript can be quiet after
      // VAD stop. Keep waiting for ASR while it has a chance to arrive, but
      // retain the same finite unknown-input safety fallback as sustained
      // speech; otherwise a missing ASR completion strands the turn forever.
      if ((!inputActive || overlap.userPaused) && !overlap.inputCommitted) {
        return noHandoff("awaiting_transcript");
      }
      // Before a sustained run is observed, output gaps and phrase boundaries
      // are intentionally ignored: a 150-600 ms “mm-hm” must not cancel the
      // assistant just because its audio happens to pause at the same time.
      if (sustained && snapshot.outputQuiet && snapshot.assistantAudioPlaying) {
        return this.emitHandoff("output_quiet", this.policy.naturalFadeMs);
      }
      if (sustained && (snapshot.outputBoundary === "phrase" || snapshot.outputBoundary === "sentence")) {
        return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
      }
      const outputBoundaryAt = typeof snapshot.outputBoundaryAt === "number"
        && Number.isFinite(snapshot.outputBoundaryAt)
        ? snapshot.outputBoundaryAt
        : null;
      // Once the user has clearly held the floor, an upcoming punctuation
      // boundary is safe to await even before the absolute fallback. Keep the
      // grace window anchored to the original safety deadline so a timeline
      // that keeps moving cannot hold the old answer forever.
      if (sustained && outputBoundaryAt !== null) {
        const boundaryGraceUntil = safetyAt + Math.max(0, this.policy.boundaryGraceMs);
        if (outputBoundaryAt <= boundaryGraceUntil) {
          if (outputBoundaryAt <= nowMs) {
            return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
          }
          if (outputBoundaryAt <= nowMs + this.policy.boundaryGraceMs) {
            return noHandoff("awaiting_output_boundary", outputBoundaryAt);
          }
        }
      }
      if (elapsed >= safetyAt) {
        // Unknown input is deliberately conservative before its safety wall:
        // a delayed transcript may still prove that this was only a small
        // acknowledgement. Once the wall is reached, however, prefer a real
        // output gap or the next measured phrase/sentence boundary so the
        // fallback does not cut through an audible thought. The absolute cap
        // is anchored to the original overlap, so a timeline that repeatedly
        // retimes its next boundary cannot defer the handoff forever.
        if (snapshot.outputQuiet && snapshot.assistantAudioPlaying) {
          return this.emitHandoff("output_quiet", this.policy.naturalFadeMs);
        }
        if (snapshot.outputBoundary === "phrase" || snapshot.outputBoundary === "sentence") {
          return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
        }
        const boundaryGraceUntil = safetyAt + Math.max(0, this.policy.boundaryGraceMs);
        if (outputBoundaryAt !== null && outputBoundaryAt <= boundaryGraceUntil) {
          if (outputBoundaryAt <= nowMs) {
            return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
          }
          if (outputBoundaryAt <= nowMs + this.policy.boundaryGraceMs) {
            return noHandoff("awaiting_output_boundary", outputBoundaryAt);
          }
        }
        return this.emitHandoff("safety_handoff", this.policy.safetyFadeMs);
      }
      // Wake at the sustained-input threshold so a newly observed output gap
      // or phrase boundary can hand off immediately, without waiting for the
      // old unknown-input safety wall.
      const sustainedAt = !sustained && inputActive
        ? overlap.lastInputSampleAt + Math.max(0, this.policy.unknownSustainedInputMs - overlap.activeInputStreakMs)
        : null;
      return noHandoff("awaiting_transcript", sustainedAt !== null ? Math.min(safetyAt, sustainedAt) : safetyAt);
    }

    if (elapsed < this.policy.minimumOverlapMs) {
      return noHandoff("awaiting_pause", overlap.startedAt + this.policy.minimumOverlapMs);
    }

    // If generation is reserved but no assistant audio has started yet, there
    // is no audible word to protect. Yield after the short overlap floor rather
    // than waiting for the substantive safety wall or a timeline that cannot
    // exist yet. `output_quiet` is also used for a measured gap, so callers
    // should treat both cases as a short fade, not as an audio timestamp.
    if (snapshot.assistantGenerating && !snapshot.assistantAudioPlaying) {
      return this.emitHandoff("output_quiet", this.policy.naturalFadeMs);
    }

    // Phrase/sentence output boundaries are the next-best point while the user
    // is still speaking. A word boundary alone is intentionally insufficient;
    // ending on a random word is exactly the abrupt feeling this policy avoids.
    if (
      (snapshot.outputBoundary === "phrase" || snapshot.outputBoundary === "sentence")
      && (overlap.hasClauseBoundary || overlap.transcriptComplete || kind === "substantive")
    ) {
      return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
    }

    const safetyAt = overlap.startedAt + this.policy.substantiveSafetyMs;
    // A user pause alone can land in the middle of a remote audio word. Only
    // an observed output gap (the caller should require roughly 160 ms of
    // silence) is allowed to cut before the bounded safety deadline.
    if (snapshot.outputQuiet && snapshot.assistantAudioPlaying) {
      return this.emitHandoff("output_quiet", this.policy.naturalFadeMs);
    }
    const outputBoundaryAt = typeof snapshot.outputBoundaryAt === "number"
      && Number.isFinite(snapshot.outputBoundaryAt)
      ? snapshot.outputBoundaryAt
      : null;
    if (outputBoundaryAt !== null) {
      // If the timeline can see a sentence/clause ending shortly ahead, keep
      // the old answer alive until that actual playback deadline. This is the
      // difference between a conversational handoff and a mid-word cutoff.
      if (outputBoundaryAt <= nowMs) {
        return this.emitHandoff("output_boundary", this.policy.naturalFadeMs);
      }
      // A timeline that keeps moving its next boundary must not slide this
      // grace window forever. Bound it from the overlap's original safety
      // wall; the boundary may be awaited only when it is both nearby and
      // inside that absolute window.
      const boundaryGraceUntil = safetyAt + Math.max(0, this.policy.boundaryGraceMs);
      if (
        outputBoundaryAt <= nowMs + this.policy.boundaryGraceMs
        && outputBoundaryAt <= boundaryGraceUntil
      ) {
        return noHandoff("awaiting_output_boundary", outputBoundaryAt);
      }
    }
    if (elapsed >= this.policy.substantiveSafetyMs) {
      return this.emitHandoff("safety_handoff", this.policy.safetyFadeMs);
    }
    if (naturalPause) return noHandoff("awaiting_output_boundary", safetyAt);

    return noHandoff(
      snapshot.outputBoundary === "word" ? "awaiting_output_boundary" : "awaiting_pause",
      safetyAt,
    );
  }

  private ensureOverlap(nowMs: number, inputActive: boolean): Overlap {
    if (this.overlap) return this.overlap;
    this.overlap = {
      startedAt: nowMs,
      lastInputSampleAt: nowMs,
      activeInputMs: 0,
      activeInputStreakMs: 0,
      sustainedInputObserved: false,
      inputWasActive: inputActive,
      transcript: "",
      transcriptComplete: false,
      transcriptKind: "unknown",
      inputCommitted: false,
      hasClauseBoundary: false,
      stopIntent: false,
      userPaused: false,
      handoffEmitted: false,
    };
    return this.overlap;
  }

  private emitHandoff(reason: "output_quiet" | "output_boundary" | "safety_handoff" | "explicit_stop" | "stop_intent", fadeMs: number): TalkOverDecision {
    if (!this.overlap) return noHandoff("assistant_inactive");
    this.overlap.handoffEmitted = true;
    return { handoff: true, reason, fadeMs };
  }
}
