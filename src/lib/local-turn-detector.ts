/**
 * A small, deterministic input turn detector for WebRTC microphone meters.
 *
 * This is deliberately independent of the Realtime provider's VAD. The
 * caller feeds it normalized RMS samples (normally once per animation frame)
 * and owns the resulting `started`/`stopped` events. It uses a short attack,
 * a longer release, and a bounded noise-floor estimate so a single click does
 * not become a turn while a quiet voice still can.
 */

export type LocalTurnDetectorOptions = {
  /** Consecutive above-threshold time needed to start a turn. */
  attackMs?: number;
  /** Consecutive below-hysteresis time needed to stop a turn. */
  releaseMs?: number;
  /** Hard upper bound for one continuous local utterance; null disables it. */
  maxUtteranceMs?: number | null;
  /** Time constant for the idle noise-floor EWMA. */
  noiseFloorMs?: number;
  /** Absolute RMS floor for speech detection. */
  speechThreshold?: number;
  /** Multiplier applied to the adaptive noise floor. */
  speechToNoiseRatio?: number;
};

export type LocalTurnDetectorUpdate = {
  /** Monotonic timestamp in milliseconds. */
  nowMs: number;
  /** Normalized RMS amplitude, normally in the 0..1 range. */
  rms: number;
  /** Temporarily disable detection without destroying the detector state. */
  enabled?: boolean;
};

export type LocalTurnDetectorReason =
  | "none"
  | "speech"
  | "silence"
  | "max_duration"
  | "disabled";

export type LocalTurnDetectorState = {
  started: boolean;
  stopped: boolean;
  active: boolean;
  rms: number;
  noiseFloor: number;
  /** Above-threshold time for the current candidate or active utterance. */
  speechMs: number;
  /** Below-hysteresis time accumulated by the active utterance. */
  silenceMs: number;
  /** Active utterance duration, never negative. */
  elapsedMs: number;
  reason: LocalTurnDetectorReason;
};

const DEFAULT_ATTACK_MS = 78;
const DEFAULT_RELEASE_MS = 580;
const DEFAULT_MAX_UTTERANCE_MS = 25_000;
const DEFAULT_NOISE_FLOOR_MS = 1_200;
const DEFAULT_SPEECH_THRESHOLD = 0.007;
const DEFAULT_SPEECH_TO_NOISE_RATIO = 2.2;
const INITIAL_NOISE_FLOOR = 0.0025;
const MIN_NOISE_FLOOR = 0.0005;
const MAX_NOISE_FLOOR = 0.08;
const MAX_CANDIDATE_GAP_MS = 180;
// Calibration runs before the data channel opens, when the mic should be
// quiet. Clip each sample relative to the current floor so one cough, click,
// or connection pop cannot teach an enormous threshold in one frame.
const CALIBRATION_OUTLIER_RATIO = 3.5;

function positiveOption(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function normalizedRms(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizedTime(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/**
 * Pure stateful detector. It has no timers, DOM, audio, or network
 * dependency, which makes it safe to drive from a Web Audio analyser or a
 * deterministic fixture.
 */
export class LocalTurnDetector {
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly maxUtteranceMs: number | null;
  private readonly noiseFloorMs: number;
  private readonly speechThreshold: number;
  private readonly speechToNoiseRatio: number;

  private enabled = true;
  private isActive = false;
  private rearmRequired = false;
  private hasTime = false;
  private lastNowMs = 0;
  private candidateSinceMs: number | null = null;
  private activeSinceMs: number | null = null;
  private activeElapsedMs = 0;
  private silenceElapsedMs = 0;
  private noiseFloor = INITIAL_NOISE_FLOOR;

  constructor(options: LocalTurnDetectorOptions = {}) {
    this.attackMs = positiveOption(options.attackMs, DEFAULT_ATTACK_MS, 1);
    this.releaseMs = positiveOption(options.releaseMs, DEFAULT_RELEASE_MS, 1);
    this.maxUtteranceMs = options.maxUtteranceMs === null
      ? null
      : positiveOption(options.maxUtteranceMs, DEFAULT_MAX_UTTERANCE_MS, 1);
    this.noiseFloorMs = positiveOption(options.noiseFloorMs, DEFAULT_NOISE_FLOOR_MS, 1);
    this.speechThreshold = positiveOption(options.speechThreshold, DEFAULT_SPEECH_THRESHOLD, 0.00001);
    this.speechToNoiseRatio = positiveOption(
      options.speechToNoiseRatio,
      DEFAULT_SPEECH_TO_NOISE_RATIO,
      1,
    );
  }

  get active(): boolean {
    return this.isActive;
  }

  /**
   * Reset the turn and return to the initial quiet baseline. An optional time
   * seeds the next update without making a synthetic clock jump.
   */
  reset(nowMs?: number, preserveNoiseFloor = false): void {
    this.enabled = true;
    this.isActive = false;
    this.rearmRequired = false;
    this.candidateSinceMs = null;
    this.activeSinceMs = null;
    this.activeElapsedMs = 0;
    this.silenceElapsedMs = 0;
    if (!preserveNoiseFloor) this.noiseFloor = INITIAL_NOISE_FLOOR;
    if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
      this.hasTime = true;
      this.lastNowMs = Math.max(0, nowMs);
    } else {
      this.hasTime = false;
      this.lastNowMs = 0;
    }
  }

  /**
   * Learn the quiet microphone baseline before the live session is armed.
   * Calibration never emits a turn event and never leaves a candidate active;
   * the caller should pass the final timestamp to reset(..., true) when the
   * data channel opens.
   */
  calibrate(input: Pick<LocalTurnDetectorUpdate, "nowMs" | "rms">): LocalTurnDetectorState {
    const { deltaMs } = this.acceptTime(input.nowMs);
    const rms = normalizedRms(input.rms);

    this.enabled = true;
    this.isActive = false;
    this.rearmRequired = false;
    this.candidateSinceMs = null;
    this.activeSinceMs = null;
    this.activeElapsedMs = 0;
    this.silenceElapsedMs = 0;

    if (deltaMs > 0) {
      const calibrationCeiling = Math.max(
        this.speechThreshold * 1.25,
        this.noiseFloor * CALIBRATION_OUTLIER_RATIO,
      );
      const boundedRms = Math.min(rms, calibrationCeiling);
      const alpha = 1 - Math.exp(-Math.min(deltaMs, 2_000) / this.noiseFloorMs);
      this.noiseFloor = Math.min(
        MAX_NOISE_FLOOR,
        Math.max(MIN_NOISE_FLOOR, this.noiseFloor + (boundedRms - this.noiseFloor) * alpha),
      );
    }

    return this.state(rms, false, false, "none");
  }

  update(input: LocalTurnDetectorUpdate): LocalTurnDetectorState {
    const { acceptedNowMs, deltaMs } = this.acceptTime(input.nowMs);

    const rms = normalizedRms(input.rms);
    const enabled = input.enabled ?? this.enabled;
    let started = false;
    let stopped = false;
    let reason: LocalTurnDetectorReason = "none";

    if (!enabled) {
      this.enabled = false;
      this.candidateSinceMs = null;
      this.silenceElapsedMs = 0;
      if (this.isActive) {
        this.isActive = false;
        this.activeSinceMs = null;
        this.activeElapsedMs = 0;
        this.rearmRequired = false;
        stopped = true;
        reason = "disabled";
      }
      return this.state(rms, started, stopped, reason);
    }
    this.enabled = true;

    const startThreshold = this.startThreshold();
    const stopThreshold = this.stopThreshold(startThreshold);

    if (this.rearmRequired) {
      // A max-duration boundary must not immediately fire a second turn on
      // the same continuously-hot sample. One below-threshold sample arms the
      // next utterance without requiring a long silence.
      if (rms <= stopThreshold) this.rearmRequired = false;
      this.updateNoiseFloor(rms, deltaMs, startThreshold);
      return this.state(rms, started, stopped, reason);
    }

    if (this.isActive) {
      this.activeElapsedMs = this.maxUtteranceMs === null
        ? this.activeElapsedMs + deltaMs
        : Math.min(this.maxUtteranceMs, this.activeElapsedMs + deltaMs);
      if (rms > stopThreshold) {
        this.silenceElapsedMs = 0;
      } else {
        this.silenceElapsedMs += deltaMs;
      }

      if (this.maxUtteranceMs !== null && this.activeElapsedMs >= this.maxUtteranceMs) {
        this.isActive = false;
        this.activeSinceMs = null;
        this.candidateSinceMs = null;
        this.silenceElapsedMs = 0;
        this.rearmRequired = true;
        stopped = true;
        reason = "max_duration";
      } else if (this.silenceElapsedMs >= this.releaseMs) {
        this.isActive = false;
        this.activeSinceMs = null;
        this.candidateSinceMs = null;
        this.activeElapsedMs = Math.max(0, this.activeElapsedMs);
        this.silenceElapsedMs = Math.min(this.releaseMs, this.silenceElapsedMs);
        stopped = true;
        reason = "silence";
      }
      return this.state(rms, started, stopped, reason);
    }

    // Idle noise is learned only while there is no speech candidate. Freezing
    // the floor during the attack prevents a quiet voice from raising its own
    // threshold before the 78 ms confirmation window completes.
    if (rms >= startThreshold) {
      if (this.candidateSinceMs === null || deltaMs > MAX_CANDIDATE_GAP_MS) {
        this.candidateSinceMs = acceptedNowMs;
      } else if (acceptedNowMs - this.candidateSinceMs >= this.attackMs) {
        this.isActive = true;
        this.activeSinceMs = acceptedNowMs;
        this.activeElapsedMs = 0;
        this.silenceElapsedMs = 0;
        this.candidateSinceMs = null;
        started = true;
        reason = "speech";
      }
    } else {
      this.candidateSinceMs = null;
      this.updateNoiseFloor(rms, deltaMs, startThreshold);
    }

    return this.state(rms, started, stopped, reason);
  }

  private startThreshold(): number {
    return Math.max(this.speechThreshold, this.noiseFloor * this.speechToNoiseRatio);
  }

  private acceptTime(inputNowMs: number): { acceptedNowMs: number; deltaMs: number } {
    const nowMs = normalizedTime(inputNowMs, this.lastNowMs);
    const previousNowMs = this.hasTime ? this.lastNowMs : nowMs;
    // A clock correction must never make accumulated durations negative. Keep
    // the latest accepted time so a later valid sample can resume naturally.
    const acceptedNowMs = Math.max(previousNowMs, nowMs);
    const deltaMs = this.hasTime ? acceptedNowMs - previousNowMs : 0;
    this.hasTime = true;
    this.lastNowMs = acceptedNowMs;
    return { acceptedNowMs, deltaMs };
  }

  private stopThreshold(startThreshold: number): number {
    return Math.max(
      this.speechThreshold * 0.55,
      this.noiseFloor * 1.45,
      startThreshold * 0.62,
    );
  }

  private updateNoiseFloor(rms: number, deltaMs: number, startThreshold: number): void {
    if (rms > startThreshold * 0.82 || deltaMs <= 0) return;
    const alpha = 1 - Math.exp(-Math.min(deltaMs, 2_000) / this.noiseFloorMs);
    this.noiseFloor = Math.min(
      MAX_NOISE_FLOOR,
      Math.max(MIN_NOISE_FLOOR, this.noiseFloor + (rms - this.noiseFloor) * alpha),
    );
  }

  private state(
    rms: number,
    started: boolean,
    stopped: boolean,
    reason: LocalTurnDetectorReason,
  ): LocalTurnDetectorState {
    return {
      started,
      stopped,
      active: this.isActive,
      rms,
      noiseFloor: this.noiseFloor,
      speechMs: this.isActive
        ? this.activeElapsedMs
        : this.candidateSinceMs === null ? 0 : Math.max(0, this.lastNowMs - this.candidateSinceMs),
      silenceMs: Math.max(0, this.silenceElapsedMs),
      elapsedMs: Math.max(0, this.activeElapsedMs),
      reason,
    };
  }
}
