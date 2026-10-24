import { speechPunctuation } from "./spoken-caption";

export type SpeechBeatSpan = { start: number; end: number; text: string; complete: boolean };

/**
 * Small meaning-sized spans from words the voice has actually generated.
 * This is an acting lookahead, not a caption splitter or a second transcript.
 * Stable character starts let a growing phrase be refined before playback
 * without scheduling a new reaction for every text delta.
 */
export function speechBeatSpans(text: string, complete = false): SpeechBeatSpan[] {
  const words = [...text.matchAll(/\S+/gu)];
  if (!complete && !/[\s.!?,;:]$/u.test(text)) words.pop();
  const spans: SpeechBeatSpan[] = [];
  let start = 0;
  const clean = (at: number) => (words[at]?.[0] ?? "").toLocaleLowerCase().replace(/[^\p{L}']/gu, "");
  const add = (end: number, finished: boolean) => {
    if (end <= start || spans.length >= 64) return;
    const from = words[start].index!;
    const last = words[end - 1];
    const through = last.index! + last[0].length;
    spans.push({ start: from, end: through, text: text.slice(from, through), complete: finished });
    start = end;
  };
  for (let at = 0; at < words.length; at += 1) {
    const contrast = /^(?:but|although|though|still|yet|however)$/u.test(clean(at))
      || (clean(at) === "and" && clean(at + 1) === "still");
    if (contrast && at - start >= 3 && clean(at - 1) !== "and") add(at, true);
    const punctuation = speechPunctuation(words[at][0]);
    if (punctuation !== "none" && (punctuation !== "comma" || at - start >= 2)) add(at + 1, true);
  }
  if (complete || words.length - start >= 4) add(words.length, complete);
  return spans;
}
