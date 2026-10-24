export type TranscriptChunk = {
  chunk: string;
  rest: string;
  delay: number;
};

const MIN_DELAY = 170;
const MAX_DELAY = 490;

export function takeTranscriptChunk(buffer: string, complete = false): TranscriptChunk | null {
  if (!buffer.trim()) return null;

  const match = buffer.match(/^\s*\S+\s*/u);
  let chunk = match?.[0] ?? buffer;
  // Occasionally a generated sentence omits the separating space (laugh.So).
  // Split at the real word edge while preserving original character offsets;
  // otherwise caption/acting word indices disagree with formatted text.
  const joinedSentence = /(?<=[!?])(?=\p{L})|(?<=\p{Ll}\.)(?=\p{Lu})/u.exec(chunk);
  if (joinedSentence && joinedSentence.index > 0) chunk = chunk.slice(0, joinedSentence.index);
  // Display formatting turns an em/en dash into a comma and a word edge.
  // Consume the raw separator with the preceding word, so 'Wait — that' and
  // 'worked–really' have the same indices on the caption and acting clocks.
  const joinedDash = /[—–]+\s*/u.exec(chunk);
  if (joinedDash && joinedDash.index > chunk.search(/\S/u)) {
    chunk = chunk.slice(0, joinedDash.index + joinedDash[0].length);
  }
  const trailingPunctuation = /^(?:[—–,.;!?]+\s*)+/u.exec(buffer.slice(chunk.length));
  if (trailingPunctuation) chunk += trailingPunctuation[0];
  // A text delta may end in the middle of a word. Do not show "conver" and
  // count it as a spoken beat before the next delta supplies "sation".
  if (!complete && chunk.length === buffer.length && !/\s$/u.test(chunk)) return null;
  const rest = buffer.slice(chunk.length);
  const visibleLength = Math.max(1, chunk.trim().length);
  // Generated text often arrives far ahead of audible speech. Backlog is not
  // permission to accelerate the caption; the playback layer gates pauses.
  const punctuationPause = /[.!?]\s*$/.test(chunk) ? 105 : /[,;:]\s*$/.test(chunk) ? 45 : 0;
  const delay = Math.round(Math.min(MAX_DELAY, Math.max(MIN_DELAY, 105 + visibleLength * 43 + punctuationPause)));

  return { chunk, rest, delay };
}

export function missingTranscriptSuffix(streamed: string, completed: string): string {
  if (!completed || completed === streamed) return "";
  return completed.startsWith(streamed) ? completed.slice(streamed.length) : "";
}

/** Realtime can return separate commentary and answer audio items. */
export class OutputTranscriptStream {
  private itemId: string | undefined;
  private itemText = "";
  private text = "";
  private seen = new Set<string>();

  reset(): void {
    this.itemId = undefined;
    this.itemText = "";
    this.text = "";
    this.seen.clear();
  }

  append(value: string, itemId?: string, complete = false): string {
    if (!value) return "";
    let separator = "";
    if (itemId && itemId !== this.itemId) {
      // A repeated completion from a retired item cannot replay its words.
      if (this.seen.has(itemId)) return "";
      this.seen.add(itemId);
      this.itemId = itemId;
      this.itemText = "";
      if (this.text && !/\s$/u.test(this.text) && !/^\s/u.test(value)) separator = " ";
    }
    const addition = complete
      ? missingTranscriptSuffix(itemId ? this.itemText : this.text, value)
      : value;
    if (!addition) return "";
    this.itemText += addition;
    this.text += separator + addition;
    return separator + addition;
  }
}
