import { takeTranscriptChunk } from "./transcript-stream";
import { speechPunctuation } from "./spoken-caption";
import { formatTranscript } from "./transcript";

export const CAPTION_LEAD_MS = 80;
export const ACTING_LEAD_MS = 180;

// A quiet run is only meaningful to the timeline when it looks like a
// sentence/clause pause. Short gaps between individual words must not turn
// the audio analyser into a per-word gate.
const MIN_PHRASE_PAUSE_MS = 180;
const MAX_PHRASE_PAUSE_HOLD_MS = 1_800;
/**
 * Longest a new sentence waits, past its estimated start, for the voice to
 * actually pause and resume. Real sentence pauses are often far longer than
 * the estimate allows, so without this gate the next sentence's words (and
 * the expressions anchored to them) ran up to a second ahead of the voice.
 */
const MAX_SENTENCE_GATE_MS = 1_600;

type PhrasePause = {
  startedMs: number;
  /** The punctuation-bearing word that may still be in flight. */
  boundaryIndex: number;
  /** The first word after the boundary; this is the hold cursor. */
  nextIndex: number;
  confirmed: boolean;
};

export type TimelineWord = {
  index: number;
  text: string;
  chunk: string;
  charEnd: number;
  startMs: number;
  endMs: number;
};

/** A duration weight, not a claim to phoneme/word alignment from the API. */
export function spokenWordWeight(word: string): number {
  const plain = word.toLocaleLowerCase().replace(/[^\p{L}'’]/gu, "");
  const groups = plain.match(/[aeiouy]+/gu)?.length ?? 1;
  const syllables = Math.max(1, groups - (/[^aeiou]e$/u.test(plain) ? 1 : 0));
  const short = /^(?:a|an|the|of|to|on|in|at|for|it|i|you|we|your|my|is|was|and|but|can|that)$/u.test(plain);
  const spoken = short ? 150 : Math.min(500, 120 + syllables * 55 + Math.min(10, plain.length) * 8);
  const punctuation = speechPunctuation(word);
  const pause = punctuation === "none" ? 0 : punctuation === "comma" ? 85 : 350;
  return spoken + pause;
}

/**
 * One absolute, monotonic timeline. Timer jitter and quiet phonemes do not add
 * a fresh word delay. The local audio clock drives both captions and acting.
 * Realtime supplies no word offsets: these weights remain an explicit estimate.
 */
export class SpeechTimeline {
  private text = "";
  private complete = false;
  private entries: TimelineWord[] = [];
  private durationMs: number | null = null;
  private cursor = 0;
  private elapsedMs = 0;
  private observedAudioElapsedMs = 0;
  private audioWasAudible = false;
  /** Sentence gating only applies once a real audio clock is feeding pauses. */
  private audioWasObserved = false;
  private pendingPhrasePause: PhrasePause | null = null;
  private phraseAnchors = new Map<number, number>();

  get words(): readonly TimelineWord[] { return this.entries; }
  get releasedWords(): number { return this.cursor; }

  reset(): void {
    this.text = "";
    this.complete = false;
    this.entries = [];
    this.durationMs = null;
    this.cursor = 0;
    this.elapsedMs = 0;
    this.observedAudioElapsedMs = 0;
    this.audioWasAudible = false;
    this.audioWasObserved = false;
    this.pendingPhrasePause = null;
    this.phraseAnchors.clear();
  }

  updateText(text: string, complete = false): void {
    if (!text.startsWith(this.text)) this.reset();
    this.text = text;
    this.complete = complete;
    const entries: TimelineWord[] = [];
    let rest = text;
    let charEnd = 0;
    let startMs = 0;
    while (rest.trim() && entries.length < 4096) {
      const part = takeTranscriptChunk(rest, complete);
      if (!part) break;
      charEnd += part.chunk.length;
      const index = entries.length;
      const previous = this.entries[index];
      const wordText = formatTranscript(part.chunk).trim();
      const duration = spokenWordWeight(wordText) + (/\n/u.test(part.chunk) && speechPunctuation(wordText) === "none" ? 350 : 0);
      const kept = previous && index < this.cursor;
      const entry = { index, text: wordText, chunk: part.chunk, charEnd,
        startMs: kept ? previous.startMs : startMs,
        endMs: kept ? previous.endMs : startMs + duration };
      entries.push(entry);
      startMs = entry.endMs;
      rest = part.rest;
    }
    this.entries = entries;
    this.retimeFuture();
  }

  setDuration(durationMs: number, elapsedMs = 0): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120_000) return;
    this.durationMs = durationMs;
    this.elapsedMs = Math.max(this.elapsedMs, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    this.retimeFuture();
  }

  /**
   * Feed the local output clock's coarse audibility state into the timeline.
   *
   * This intentionally reacts only to a sustained pause immediately after a
   * strong punctuation/clause boundary. It never gates ordinary words on RMS
   * and never rewinds the release cursor. A missing resume is bounded so an
   * unusual model pause cannot deadlock captions forever.
   */
  observeAudio(elapsedMs: number, audible: boolean): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const at = Math.max(this.observedAudioElapsedMs, elapsedMs);
    this.observedAudioElapsedMs = at;

    if (audible) {
      this.audioWasObserved = true;
      const pending = this.pendingPhrasePause;
      if (pending) {
        const quietMs = Math.max(0, at - pending.startedMs);
        if (quietMs >= MIN_PHRASE_PAUSE_MS) {
          this.confirmPhrasePause(pending, at);
          const boundedResume = Math.min(at, pending.startedMs + MAX_PHRASE_PAUSE_HOLD_MS);
          this.phraseAnchors.set(pending.nextIndex, boundedResume);
          this.applyPhraseAnchors();
        }
        this.pendingPhrasePause = null;
      }
      this.audioWasAudible = true;
      return;
    }

    if (this.pendingPhrasePause !== null) {
      if (at - this.pendingPhrasePause.startedMs >= MIN_PHRASE_PAUSE_MS) {
        this.confirmPhrasePause(this.pendingPhrasePause, at);
      }
      this.audioWasAudible = false;
      return;
    }

    if (!this.audioWasAudible) return;
    this.audioWasAudible = false;

    const candidate = this.nextPhraseStartIndex();
    if (candidate !== null && !this.phraseAnchors.has(candidate.nextIndex)) {
      this.pendingPhrasePause = { ...candidate, startedMs: at, confirmed: false };
    }
  }

  private confirmPhrasePause(pending: PhrasePause, at: number): void {
    if (pending.confirmed) return;
    pending.confirmed = true;

    // A scaled estimate can leave the last spoken word just beyond the quiet
    // edge. Pull only that boundary onset forward to the measured pause so it
    // can be released, while the following phrase remains held. This is still
    // intentionally coarse: the analyser identifies a phrase pause, not a
    // phoneme boundary.
    const boundary = this.entries[pending.boundaryIndex];
    if (!boundary || pending.boundaryIndex < this.cursor) return;
    const start = Math.min(boundary.startMs, at);
    boundary.startMs = Math.max(0, start);
    boundary.endMs = Math.max(boundary.startMs, Math.min(boundary.endMs, at));
    const previous = this.entries[pending.boundaryIndex - 1];
    if (previous) previous.endMs = Math.min(previous.endMs, boundary.startMs);
  }

  private retimeFuture(): void {
    if (this.complete && this.durationMs !== null && this.entries.length) {
      // Freeze already-visible onsets. Include the current word's remaining
      // duration in the budget so a late estimate cannot restart that word.
      const start = Math.max(0, this.cursor - 1);
      const anchor = this.entries[start].startMs;
      const remaining = this.entries.slice(start);
      const weights = remaining.map((word) => spokenWordWeight(word.text) + (/\n/u.test(word.chunk) && speechPunctuation(word.text) === "none" ? 350 : 0));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const budget = Math.max(1, this.durationMs - anchor);
      let at = anchor;
      for (let offset = 0; offset < remaining.length; offset += 1) {
        const index = start + offset;
        const end = at + weights[offset] / total * budget;
        if (index >= this.cursor) {
          // A correction can catch up on the next frame, but does not run an
          // independent typewriter queue or replay any prior caption.
          this.entries[index].startMs = at;
        }
        this.entries[index].endMs = Math.max(this.entries[index].startMs, end);
        at = end;
      }
    }
    this.applyPhraseAnchors();
  }

  private nextPhraseStartIndex(): Omit<PhrasePause, "startedMs" | "confirmed"> | null {
    if (this.cursor <= 0) return null;
    // Normally the boundary is the last released word. During a long pause,
    // though, a duration-scaled estimate may leave that final word one or two
    // entries ahead of the release cursor. Look ahead narrowly so a pause can
    // still hold the next phrase without turning the whole transcript into a
    // global RMS gate.
    const first = Math.max(0, this.cursor - 1);
    const last = Math.min(this.entries.length - 2, this.cursor + 2);
    for (let boundaryIndex = first; boundaryIndex <= last; boundaryIndex += 1) {
      const boundary = this.entries[boundaryIndex];
      if (!boundary) continue;
      const punctuation = speechPunctuation(boundary.text);
      const strongBoundary = punctuation !== "none" || /\n/u.test(boundary.chunk);
      if (strongBoundary) return { boundaryIndex, nextIndex: boundaryIndex + 1 };
    }
    return null;
  }

  private applyPhraseAnchors(): void {
    if (!this.entries.length || !this.phraseAnchors.size) return;
    const anchors = [...this.phraseAnchors.entries()].sort(([left], [right]) => left - right);
    for (const [index, targetMs] of anchors) {
      if (index < this.cursor || index >= this.entries.length || !Number.isFinite(targetMs)) continue;
      const previous = index > 0 ? this.entries[index - 1] : null;
      // The measured resume is the useful boundary. A previous estimated end
      // may include a long, invented punctuation pause, so do not force the
      // next phrase to wait for that stale end. Keep ranges ordered by
      // shortening only the preceding unreleased estimate when necessary.
      const target = Math.max(previous?.startMs ?? 0, targetMs, 0);
      if (previous && previous.endMs > target) previous.endMs = target;
      const current = this.entries[index].startMs;
      if (this.durationMs !== null) {
        // A known response budget includes the pause. Reflow only the
        // unreleased suffix from the observed resume to that budget so an
        // anchor cannot make the final word drift past the audio estimate.
        const finish = Math.max(target, this.durationMs);
        const remaining = this.entries.slice(index);
        const weights = remaining.map((word) => spokenWordWeight(word.text) + (/\n/u.test(word.chunk) && speechPunctuation(word.text) === "none" ? 350 : 0));
        const total = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0));
        let at = target;
        for (let offset = 0; offset < remaining.length; offset += 1) {
          const entry = this.entries[index + offset];
          const end = offset === remaining.length - 1
            ? finish
            : at + weights[offset] / total * (finish - target);
          entry.startMs = at;
          entry.endMs = Math.max(at, end);
          at = entry.endMs;
        }
      } else if (target !== current) {
        // With no duration estimate, retain the authored relative pacing and
        // rebase the future suffix on the measured resume (in either
        // direction) without touching released entries.
        const shift = target - current;
        for (let cursor = index; cursor < this.entries.length; cursor += 1) {
          this.entries[cursor].startMs += shift;
          this.entries[cursor].endMs += shift;
        }
      }
    }
  }

  peek(elapsedMs: number, leadMs = 0): { wordCount: number; charEnd: number } {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { wordCount: 0, charEnd: 0 };
    const at = elapsedMs + Math.max(0, Math.min(250, Number.isFinite(leadMs) ? leadMs : 0));
    let wordCount = 0;
    let charEnd = 0;
    for (const word of this.entries) {
      if (word.startMs > at) break;
      wordCount += 1;
      charEnd = word.charEnd;
    }
    const pending = this.pendingPhrasePause;
    if (pending && at >= pending.startedMs && at < pending.startedMs + MAX_PHRASE_PAUSE_HOLD_MS) {
      wordCount = Math.min(wordCount, pending.nextIndex);
      charEnd = wordCount > 0 ? this.entries[wordCount - 1].charEnd : 0;
    }
    const gate = this.sentenceGate(elapsedMs);
    if (gate !== null && wordCount > gate) {
      wordCount = gate;
      charEnd = wordCount > 0 ? this.entries[wordCount - 1].charEnd : 0;
    }
    return { wordCount, charEnd };
  }

  /**
   * Index of the first word that must wait, or null when nothing is gated.
   * A word that opens a new sentence is held until the audio has paused and
   * resumed after the sentence before it (a phrase anchor exists for it),
   * the response has stopped being audible-tracked, or a bounded fallback
   * passes. Only sentence endings gate; commas keep their estimated pacing.
   */
  private sentenceGate(elapsedMs: number): number | null {
    if (!this.audioWasObserved) return null;
    const first = Math.max(0, this.cursor - 1);
    for (let index = first; index < this.entries.length - 1; index += 1) {
      const word = this.entries[index];
      const ending = speechPunctuation(word.text);
      const endsSentence = ending === "sentence" || ending === "question" || ending === "exclamation" || /\n/u.test(word.chunk);
      if (!endsSentence) continue;
      const next = index + 1;
      if (next < this.cursor) continue;
      if (this.phraseAnchors.has(next)) return null;
      if (elapsedMs >= word.endMs + MAX_SENTENCE_GATE_MS) return null;
      return next;
    }
    return null;
  }

  advance(elapsedMs: number, leadMs = CAPTION_LEAD_MS): TimelineWord[] {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return [];
    this.elapsedMs = Math.max(this.elapsedMs, elapsedMs);
    const due = this.peek(this.elapsedMs, leadMs).wordCount;
    const result = this.entries.slice(this.cursor, Math.max(this.cursor, due));
    this.cursor = Math.max(this.cursor, due);
    return result;
  }
}

export type CaptionDelayInput = {
  /** Delay weight for the caption chunk currently being released. */
  baseDelay: number;
  /** Text still queued after the current chunk. */
  remainingText: string;
  /** Milliseconds of real/estimated audio left for the current and future chunks. */
  remainingAudioMs?: number;
};

export const CAPTION_DELAY_MIN_MS = 85;
export const CAPTION_DELAY_MAX_MS = 600;

const finitePositive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

function remainingDelayWeight(text: string): number {
  if (!text) return 0;
  let rest = text;
  let total = 0;
  // A streamed response is bounded elsewhere. The guard prevents malformed
  // input with a non-progressing chunker from becoming an accidental loop.
  for (let count = 0; rest && count < 4096; count += 1) {
    const chunk = takeTranscriptChunk(rest, true);
    if (!chunk || chunk.rest === rest) break;
    if (Number.isFinite(chunk.delay) && chunk.delay > 0) total += chunk.delay;
    rest = chunk.rest;
  }
  return total;
}

/**
 * Allocates a current caption chunk's share of a real audio-time budget.
 *
 * `remainingText` is the text after the current chunk. Its delays are used as
 * relative weights, while `remainingAudioMs` is the available current+future
 * audio budget. Without a finite positive budget this deliberately returns
 * the normal transcript delay; backlog alone must never speed captions up.
 */
export function captionDelay({ baseDelay, remainingText, remainingAudioMs }: CaptionDelayInput): number {
  if (!finitePositive(baseDelay)) return CAPTION_DELAY_MIN_MS;
  if (!finitePositive(remainingAudioMs)) return baseDelay;

  const futureWeight = remainingDelayWeight(typeof remainingText === "string" ? remainingText : "");
  const denominator = baseDelay + futureWeight;
  if (!finitePositive(denominator)) return baseDelay;

  const allocated = (baseDelay / denominator) * remainingAudioMs;
  if (!Number.isFinite(allocated)) return baseDelay;
  return Math.min(CAPTION_DELAY_MAX_MS, Math.max(CAPTION_DELAY_MIN_MS, allocated));
}
