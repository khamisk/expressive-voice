import { formatTranscript } from "./transcript";

export type SpeechPunctuation = "none" | "comma" | "sentence" | "question" | "exclamation";

export type PlaybackWord = {
  word: string;
  wordTick: number;
  phraseTick: number;
  punctuation: SpeechPunctuation;
  /** Position on the same playback clock used for captions and acting. */
  atMs?: number;
};

export type CaptionPlan = { text: string; breaks: number[] };

export type CaptionOptions = {
  maxWords?: number;
  maxCharacters?: number;
  /** Generated lookahead is for grouping only, never for revealing unheard words. */
  plannedText?: string;
  /** Word offsets chosen by the model/director, not a second transcript. */
  breakBeforeWords?: readonly number[];
};

export type CaptionWindow = {
  startWord: number;
  phraseIndex: number;
  words: string[];
  text: string;
  totalWords: number;
};

export function speechPunctuation(word: string): SpeechPunctuation {
  const value = word.trim().replace(/["'”’)\]]+$/u, "");
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)\.$/iu.test(value)) return "none";
  if (/\?$/u.test(value)) return "question";
  if (/!$/u.test(value)) return "exclamation";
  if (/[.…]$/u.test(value)) return "sentence";
  if (/[,;:]$/u.test(value)) return "comma";
  return "none";
}

const cleanWord = (word: string) => word.toLocaleLowerCase().replace(/^["'“‘(]+|[.,!?;:"'”’)]+$/gu, "");
const linkedForward = new Set([
  "a", "an", "the", "my", "your", "our", "their", "his", "her", "its", "this", "these", "those",
  "to", "of", "for", "from", "with", "without", "about", "into", "onto", "at", "on", "in", "by",
  "and", "or", "but", "because", "although", "than", "very", "really", "so", "quite", "not",
  "i", "you", "we", "they", "he", "she", "it", "i'm", "you're", "we're", "they're", "it's",
]);
const clauseStarters = new Set(["but", "because", "although", "while", "when", "then", "and", "so"]);
const phraseStarters = new Set(["with", "without", "about", "from", "after", "before", "like", "in", "on", "for"]);
const objectVerbs = new Set(["tell", "told", "ask", "asked", "give", "gave", "show", "showed", "help", "helped", "thank", "thanks"]);
const objectPronouns = new Set(["me", "you", "us", "him", "her", "them", "it"]);

function captionLimit(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value!)) : fallback;
}

export function captionWords(text: string): string[] {
  return formatTranscript(text).match(/\S+/gu) ?? [];
}

/** Do not turn 'your side', 'a job', or 'going to' into two caption cards. */
export function isSafeCaptionBreak(words: readonly string[], at: number): boolean {
  if (at <= 0 || at >= words.length) return at === 0;
  const previous = words[at - 1];
  if (speechPunctuation(previous) !== "none") return true;
  if (linkedForward.has(cleanWord(previous))) return false;
  if (objectVerbs.has(cleanWord(previous)) && objectPronouns.has(cleanWord(words[at]))) return false;
  if (cleanWord(words[at]) === "to" && /^(?:going|want|wants|need|needs|have|has|trying|tried|used)$/u.test(cleanWord(previous))) return false;
  return true;
}

/**
 * Prefer complete thoughts and model-authored lines. Size is a soft fallback,
 * not a guillotine every five words. Lookahead prevents an orphan final word.
 */
export function planCaptionBreaks(text: string, options: CaptionOptions = {}): number[] {
  const formatted = formatTranscript(text);
  const tokens = [...formatted.matchAll(/\S+/gu)];
  const words = tokens.map((token) => token[0]);
  if (!words.length) return [0];
  const maxWords = captionLimit(options.maxWords, 8, 3);
  const maxCharacters = captionLimit(options.maxCharacters, 64, 16);
  const authored = new Set((options.breakBeforeWords ?? []).filter((at) => Number.isInteger(at) && isSafeCaptionBreak(words, at)));
  const ends: number[] = [];
  for (let at = 1; at < words.length; at += 1) {
    const previous = speechPunctuation(words[at - 1]);
    const gap = formatted.slice((tokens[at - 1].index ?? 0) + words[at - 1].length, tokens[at].index);
    if (authored.has(at) || (/\r?\n/u.test(gap) && isSafeCaptionBreak(words, at)) || (previous !== "none" && previous !== "comma")) ends.push(at);
  }
  ends.push(words.length);

  const breaks = [0];
  let start = 0;
  for (const end of ends) {
    while (end - start > maxWords || words.slice(start, end).join(" ").length > maxCharacters) {
      let best = -1;
      let bestScore = -Infinity;
      // Never manufacture a one-word tail just because the soft limit was met.
      const lastCandidate = Math.min(end - 2, start + maxWords);
      for (let at = start + 2; at <= lastCandidate; at += 1) {
        if (!isSafeCaptionBreak(words, at)) continue;
        const length = words.slice(start, at).join(" ").length;
        if (length > maxCharacters && at > start + 2) break;
        const previous = speechPunctuation(words[at - 1]);
        const next = cleanWord(words[at]);
        const semantic = previous === "comma" ? 5 : clauseStarters.has(next) ? 4 : phraseStarters.has(next) ? 3 : 0;
        const balance = Math.min(end - start, maxWords * 2) / 2;
        const score = semantic - Math.abs(at - start - balance) * 0.28;
        if (score > bestScore) { bestScore = score; best = at; }
      }
      if (best < 0) {
        // A short linked thought may exceed the soft limit. A malformed or
        // unusually long chain of function words must not grow a scrolling
        // paragraph, though. The emergency boundary preserves whole words
        // and leaves at least two words in the next fragment.
        const oversized = end - start > maxWords + 4
          || words.slice(start, end).join(" ").length > maxCharacters * 1.5;
        if (!oversized || end - start < 4) break;
        best = Math.min(end - 2, start + maxWords);
        while (best > start + 2 && words.slice(start, best).join(" ").length > maxCharacters) best -= 1;
      }
      breaks.push(best);
      start = best;
    }
    if (end < words.length && breaks.at(-1) !== end) breaks.push(end);
    start = end;
  }
  return breaks;
}

/** Freeze past/current boundaries: a late director result cannot replay a line. */
export class CaptionPlanner {
  private plan: CaptionPlan = { text: "", breaks: [0] };
  private spokenWords = 0;

  reset(): void { this.plan = { text: "", breaks: [0] }; this.spokenWords = 0; }

  update(text: string, options: CaptionOptions & { complete?: boolean; spokenWords?: number } = {}): CaptionPlan {
    if (!text.startsWith(this.plan.text)) this.reset();
    this.spokenWords = Math.max(this.spokenWords, options.spokenWords ?? 0);
    const proposed = planCaptionBreaks(text, options);
    const committed = this.plan.breaks.filter((at) => at < this.spokenWords);
    const future = proposed.filter((at) => at >= this.spokenWords);
    this.plan = { text, breaks: [...new Set([0, ...committed, ...future])].sort((a, b) => a - b) };
    return this.plan;
  }
}

/** A visibility toggle only changes presentation; it never owns this clock. */
export function captionWindow(audibleText: string, options: CaptionOptions = {}): CaptionWindow {
  const allWords = captionWords(audibleText);
  const plannedWords = captionWords(options.plannedText ?? audibleText);
  const matches = allWords.every((word, index) => word === plannedWords[index]);
  const source = matches ? options.plannedText ?? audibleText : audibleText;
  const sourceWords = matches ? plannedWords : allWords;
  const fallback = planCaptionBreaks(source, { ...options, breakBeforeWords: undefined });
  // Treat display boundaries as data, too. A stale/malformed offset cannot
  // put the cursor outside the phrase, replay it out of order, or strand
  // 'your / side'. Permit the planner's bounded emergency fallback for a
  // genuinely oversized linked phrase.
  const proposed = options.breakBeforeWords;
  const valid = proposed?.length && proposed.every((at, index) => Number.isInteger(at)
    && at >= 0 && (at === 0 || at < sourceWords.length)
    && (index === 0 || at > proposed[index - 1])
    && (isSafeCaptionBreak(sourceWords, at) || fallback.includes(at)));
  const breaks = matches && valid ? [...new Set([0, ...proposed])] : fallback;
  let startWord = 0;
  let phraseIndex = 0;
  for (const at of breaks) {
    if (at > 0 && at < allWords.length) { startWord = at; phraseIndex += 1; }
  }
  const words = allWords.slice(startWord);
  return { startWord, phraseIndex, words, text: words.join(" "), totalWords: allWords.length };
}
