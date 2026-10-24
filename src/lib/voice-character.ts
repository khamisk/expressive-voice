import type { AvatarExpression, ConversationPhase } from "../types";
import type { CharacterAccent } from "./character-accents";
import type { CharacterGesture } from "./character-gestures";
import type { CharacterIntent } from "./character-intents";
import type { CharacterPerformance } from "./embodied-character";
import type { ReactionCue, ReactionEffect } from "./reaction-cues";

/** Written after painting a real avatar frame, not when a tool is requested. */
export type CharacterDisplayState = {
  expression: AvatarExpression;
  phase: ConversationPhase;
  gesture: CharacterGesture;
  accent: CharacterAccent;
  intent: CharacterIntent;
  effect: ReactionEffect;
  variantId?: string;
  headTiltDegrees: number;
  observedAtMs: number;
};

export function characterContext(
  display: CharacterDisplayState | null | undefined,
  nowMs: number,
  takingOver: boolean,
): string {
  const fresh = display && Number.isFinite(display.observedAtMs)
    && nowMs - display.observedAtMs >= 0 && nowMs - display.observedAtMs < 1_500;
  const character = fresh ? {
    expression: display.expression,
    phase: display.phase,
    gesture: display.gesture,
    accent: display.accent,
    intent: display.intent,
    effect: display.effect === "heart" ? "friendly golden greeting mark" : display.effect,
    ...(display.variantId ? { variant: display.variantId } : {}),
    head_tilt_degrees: Math.round(display.headTiltDegrees),
  } : null;
  return "App context, not words to say: " + JSON.stringify({
    character_display: character,
    display_note: fresh
      ? "Latest rendered character frame; expressions can be transitioning."
      : "No fresh rendered frame is available; do not claim a particular visible pose.",
    turn_taking: takingOver
      ? "The user took the floor during your previous reply. Answer their newest point directly. The unheard remainder was discarded; do not resume or recap it."
      : "Reply to the latest user input in a short natural thought, unless they explicitly requested only a nonverbal reaction.",
  });
}

type ScheduledBeat = { cue: ReactionCue; emitted: boolean };
type TextWord = { text: string; start: number; end: number };

function words(text: string): TextWord[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(match => ({
    text: match[0].replaceAll("’", "'").toLocaleLowerCase(),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

/** Match whole spoken words while tolerating punctuation/capitalization. */
export function findCharacterAnchor(text: string, anchor: string): { start: number; firstEnd: number } | null {
  const textWords = words(text);
  const anchorWords = words(anchor);
  if (!anchorWords.length) return null;
  for (let index = 0; index <= textWords.length - anchorWords.length; index += 1) {
    if (anchorWords.every((word, offset) => word.text === textWords[index + offset].text)) {
      return { start: textWords[index].start, firstEnd: textWords[index].end };
    }
  }
  return null;
}

/**
 * A voice-authored plan owns this reply. Rendering stays local and continuous;
 * it never waits for another model to reinterpret the same spoken sentence.
 */
export class VoiceCharacterPerformance {
  private turnId: string | null = null;
  private beats: ScheduledBeat[] = [];
  private planned = false;
  private activeBeat = false;

  get hasPlan(): boolean { return this.planned; }
  get hasActiveBeat(): boolean { return this.activeBeat; }

  reset(turnId: string | null = null): void {
    this.turnId = turnId;
    this.beats = [];
    this.planned = false;
    this.activeBeat = false;
  }

  accept(plan: CharacterPerformance, callId: string): ReactionCue | null {
    if (!this.turnId || this.planned) return null;
    this.planned = true;
    this.beats = plan.beats.map((beat, index) => ({
      emitted: false,
      cue: {
        id: `voice-character:${this.turnId}:${callId}:${index}`,
        turnId: this.turnId!,
        source: beat.anchor ? "assistant" : "user",
        kind: beat.anchor ? "speech" : "reaction",
        expression: beat.expression,
        intensity: beat.intensity,
        intent: beat.intent,
        gesture: beat.gesture,
        accent: beat.accent,
        effect: beat.effect,
        confidence: 1,
        phraseIndex: index,
        ...(beat.anchor ? { anchor: beat.anchor } : {}),
      },
    }));
    const immediate = this.beats[0];
    if (immediate && !immediate.cue.anchor) {
      this.activeBeat = true;
      immediate.emitted = true;
      return immediate.cue;
    }
    return null;
  }

  release(input: {
    text: string;
    presentedChars: number;
    anticipatedChars: number;
    complete: boolean;
    audible: boolean;
  }): ReactionCue[] {
    if (!input.audible || !this.planned) return [];
    const available: ReactionCue[] = [];
    let lastStart = -1;
    for (let index = 0; index < this.beats.length; index += 1) {
      const beat = this.beats[index];
      if (!beat.cue.anchor) continue;
      const anchor = findCharacterAnchor(input.text, beat.cue.anchor);
      if (!anchor) {
        if (input.complete) beat.emitted = true;
        continue;
      }
      // A tool cannot rewind the sentence with a later out-of-order anchor.
      if (anchor.start <= lastStart) { beat.emitted = true; continue; }
      lastStart = anchor.start;
      if (beat.emitted) continue;
      const punctuation = /[.!?;\n]+(?=\s|$)/u.exec(input.text.slice(anchor.start));
      let end = punctuation ? anchor.start + punctuation.index + punctuation[0].length
        : input.complete ? input.text.length : Infinity;
      for (const later of this.beats.slice(index + 1)) {
        if (!later.cue.anchor) continue;
        const next = findCharacterAnchor(input.text, later.cue.anchor);
        if (next && next.start > anchor.start) end = Math.min(end, next.start);
      }
      if (input.presentedChars >= end) { beat.emitted = true; continue; }
      if (Math.max(input.presentedChars, input.anticipatedChars) < anchor.firstEnd) continue;
      beat.emitted = true;
      available.push(beat.cue);
    }
    // Several beats can become eligible after a stalled frame. Show the latest
    // one, never race through an animation backlog the user already heard.
    if (available.length) this.activeBeat = true;
    return available.slice(-1);
  }
}
