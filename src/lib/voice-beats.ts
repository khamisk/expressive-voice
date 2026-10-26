/**
 * Finds syllable beats in the character's own voice, as it plays.
 *
 * The Realtime API gives no word or phoneme timestamps, so the transcript
 * clock can only estimate where words fall. The audio itself does carry the
 * rhythm: every syllable is a quick rise in speech-band loudness. This
 * detector watches that rise in short blocks and emits a beat per syllable,
 * with a strength that is higher for stressed (louder than usual) syllables.
 *
 * It is causal and cheap: one pass over the newest samples each frame, no
 * FFT, no lookahead. Beats are detected at the syllable's onset, slightly
 * before its loudest point, which is when a viewer expects motion to begin.
 */

export type VoiceBeatState = {
  /** 0..1 loudness for the face, with an immediate attack and a short release. */
  level: number;
  /** Increments once per detected syllable. */
  syllableTick: number;
  /** 0..1 emphasis of the latest syllable relative to the recent speaking level. */
  strength: number;
  /** Detection time of the latest syllable, in the caller's clock. */
  syllableAtMs: number | null;
};

const BLOCK_MS = 5;
/** Below this the voice is treated as silent (dBFS of the speech band). */
const SILENCE_DB = -52;
/** A syllable is a rise of at least this much within the rise window. */
const ONSET_RISE_DB = 5;
const RISE_WINDOW_MS = 70;
/** Shortest gap between syllables; fast speech is about 7 per second. */
const REFRACTORY_MS = 105;
/** How quickly the remembered speaking level follows the voice. */
const BASELINE_SECONDS = 1.4;

export class VoiceBeatDetector {
  private highPass = 0;
  private previousSample = 0;
  private blockEnergy = 0;
  private blockCount = 0;
  private blockSize = 0;
  private envelopeDb = SILENCE_DB - 20;
  private recent: Array<{ at: number; db: number }> = [];
  private baselineDb = -30;
  private baselineReady = false;
  private lastBeatAt = -Infinity;
  private armed = true;
  private clockMs = 0;
  private level = 0;
  private state: VoiceBeatState = { level: 0, syllableTick: 0, strength: 0, syllableAtMs: null };

  reset(): void {
    this.highPass = 0;
    this.previousSample = 0;
    this.blockEnergy = 0;
    this.blockCount = 0;
    this.envelopeDb = SILENCE_DB - 20;
    this.recent = [];
    this.baselineReady = false;
    this.lastBeatAt = -Infinity;
    this.armed = true;
    this.level = 0;
    this.state = { level: 0, syllableTick: this.state.syllableTick, strength: 0, syllableAtMs: null };
  }

  /**
   * Feed only the samples that arrived since the previous call. `nowMs` is
   * the time of the newest sample. Returns the current beat state.
   */
  push(samples: ArrayLike<number>, sampleRate: number, nowMs: number): VoiceBeatState {
    if (!(sampleRate > 0)) return this.state;
    this.blockSize = Math.max(1, Math.round((sampleRate * BLOCK_MS) / 1000));
    const alpha = Math.exp((-2 * Math.PI * 250) / sampleRate);
    const startMs = nowMs - (samples.length / sampleRate) * 1000;
    let frameEnergy = 0;

    for (let i = 0; i < samples.length; i++) {
      const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
      // One-pole high-pass: drops rumble and breath so vowels dominate.
      this.highPass = alpha * (this.highPass + sample - this.previousSample);
      this.previousSample = sample;
      const energy = this.highPass * this.highPass;
      this.blockEnergy += energy;
      frameEnergy += sample * sample;
      this.blockCount += 1;
      if (this.blockCount >= this.blockSize) {
        this.closeBlock(startMs + ((i + 1) / sampleRate) * 1000);
      }
    }

    // Loudness for the face: full-band, immediate rise, ~60 ms fall.
    const rms = samples.length ? Math.sqrt(frameEnergy / samples.length) : 0;
    const target = Math.min(1, rms * 5.5);
    const elapsed = Math.max(0, nowMs - this.clockMs);
    this.clockMs = nowMs;
    this.level = target >= this.level ? target : this.level + (target - this.level) * (1 - Math.exp(-elapsed / 60));
    this.state = { ...this.state, level: this.level };
    return this.state;
  }

  private closeBlock(atMs: number): void {
    const db = 10 * Math.log10(this.blockEnergy / this.blockCount + 1e-12);
    this.blockEnergy = 0;
    this.blockCount = 0;
    // Fast envelope: follow rises at once, fall over a few blocks.
    this.envelopeDb = db > this.envelopeDb ? db : this.envelopeDb + (db - this.envelopeDb) * 0.35;
    this.recent.push({ at: atMs, db: this.envelopeDb });
    while (this.recent.length && atMs - this.recent[0].at > RISE_WINDOW_MS) this.recent.shift();

    const speaking = this.envelopeDb > SILENCE_DB;
    if (speaking) {
      // Start the remembered level from the voice's own first syllable, so
      // a quiet or loud voice is not judged against an arbitrary default.
      if (!this.baselineReady) {
        this.baselineDb = this.envelopeDb - 3;
        this.baselineReady = true;
      }
      const k = 1 - Math.exp(-(BLOCK_MS / 1000) / BASELINE_SECONDS);
      this.baselineDb += (this.envelopeDb - this.baselineDb) * k;
    }

    const floor = Math.min(...this.recent.map((entry) => entry.db));
    const rise = this.envelopeDb - floor;
    // Re-arm once the envelope has dipped between syllables, so one long
    // vowel cannot fire twice.
    if (!this.armed && rise < ONSET_RISE_DB * 0.4) this.armed = true;
    if (
      this.armed
      && speaking
      && rise >= ONSET_RISE_DB
      && this.envelopeDb > this.baselineDb - 12
      && atMs - this.lastBeatAt >= REFRACTORY_MS
    ) {
      this.lastBeatAt = atMs;
      this.armed = false;
      // Stress is mostly loudness against the recent speaking level. The rise
      // is capped: a syllable starting from silence always rises a lot, and
      // must not count as stressed just for opening a phrase.
      const emphasis = (this.envelopeDb - this.baselineDb + 4) / 12;
      const sharpness = (Math.min(rise, 18) - ONSET_RISE_DB) / 13;
      const strength = Math.max(0, Math.min(1, emphasis * 0.85 + sharpness * 0.15));
      this.state = {
        level: this.level,
        syllableTick: this.state.syllableTick + 1,
        strength,
        syllableAtMs: atMs,
      };
    }
  }
}

/**
 * Holds values until the listener can hear them.
 *
 * The voice is analysed as it enters the audio graph, but reaches the
 * speakers later by the device's output latency (often 20-40 ms on wired
 * output and 150-250 ms over Bluetooth). Without this, the face would move
 * before the sound it is reacting to.
 */
export class HeardDelay<T> {
  private queue: Array<{ at: number; value: T }> = [];
  private current: T;

  constructor(initial: T) {
    this.current = initial;
  }

  push(value: T, nowMs: number, delayMs: number): T {
    const delay = Math.max(0, Math.min(400, Number.isFinite(delayMs) ? delayMs : 0));
    this.queue.push({ at: nowMs + delay, value });
    while (this.queue.length && this.queue[0].at <= nowMs) this.current = this.queue.shift()!.value;
    if (this.queue.length > 120) this.queue.splice(0, this.queue.length - 120);
    return this.current;
  }

  reset(value: T): void {
    this.queue = [];
    this.current = value;
  }
}

/** Time between a sample entering the graph and being heard, in ms. */
export function outputDelayMs(context: AudioContext | null | undefined): number {
  if (!context) return 0;
  const stamp = context.getOutputTimestamp?.();
  if (stamp?.contextTime && stamp.contextTime > 0) {
    const measured = (context.currentTime - stamp.contextTime) * 1000;
    if (Number.isFinite(measured) && measured >= 0 && measured < 600) return measured;
  }
  const estimate = ((context.outputLatency || 0) + (context.baseLatency || 0)) * 1000;
  return Number.isFinite(estimate) ? estimate : 0;
}
