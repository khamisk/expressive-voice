import { describe, expect, it } from "vitest";
import {
  characterContext,
  findCharacterAnchor,
  VoiceCharacterPerformance,
  type CharacterDisplayState,
} from "./voice-character";
import type { CharacterPerformance, CharacterPerformanceBeat } from "./embodied-character";

function beat(overrides: Partial<CharacterPerformanceBeat> = {}): CharacterPerformanceBeat {
  return {
    expression: "neutral",
    intensity: 0.9,
    anchor: "That makes sense.",
    intent: "acknowledge",
    gesture: "still",
    accent: "none",
    effect: "none",
    ...overrides,
  };
}

function performance(beats: CharacterPerformanceBeat[]): CharacterPerformance {
  return { silent: false, beats };
}

function display(overrides: Partial<CharacterDisplayState> = {}): CharacterDisplayState {
  return {
    expression: "curious",
    phase: "speaking",
    gesture: "lean-in",
    accent: "widen",
    intent: "question",
    effect: "none",
    headTiltDegrees: 12.4,
    observedAtMs: 10_000,
    ...overrides,
  };
}

function contextJson(raw: string): Record<string, unknown> {
  const prefix = "App context, not words to say: ";
  expect(raw.startsWith(prefix)).toBe(true);
  return JSON.parse(raw.slice(prefix.length)) as Record<string, unknown>;
}

describe("voice character context and authored performance", () => {
  it("describes a fresh rendered frame as app context, not spoken content", () => {
    const context = contextJson(characterContext(display(), 10_900, false));

    expect(context.character_display).toEqual({
      expression: "curious",
      phase: "speaking",
      gesture: "lean-in",
      accent: "widen",
      intent: "question",
      effect: "none",
      head_tilt_degrees: 12,
    });
    expect(context.display_note).toContain("Latest rendered character frame");
    expect(context.turn_taking).toContain("short natural thought");
    expect(contextJson(characterContext(display(), 10_900, false))).not.toHaveProperty("spoken_text");
  });

  it("describes the friendly mark without leaking the legacy heart cue name", () => {
    const context = contextJson(characterContext(display({ effect: "heart" }), 10_900, false));
    expect(context.character_display).toMatchObject({ effect: "friendly golden greeting mark" });
    expect(JSON.stringify(context)).not.toContain("heart");
  });

  it("does not claim a stale or future pose, and marks a taking-floor newest point", () => {
    const stale = contextJson(characterContext(display(), 11_500, true));
    const future = contextJson(characterContext(display({ observedAtMs: 12_000 }), 11_500, true));

    expect(stale.character_display).toBeNull();
    expect(future.character_display).toBeNull();
    expect(stale.display_note).toContain("No fresh rendered frame");
    expect(stale.turn_taking).toContain("newest point directly");
    expect(stale.turn_taking).toContain("do not resume or recap");
    expect(stale.turn_taking).not.toContain("previous topic");
  });

  it("matches Unicode anchors as whole spoken words, including curly apostrophes", () => {
    const spoken = "C’est une très bonne idée. The party can start soon.";

    expect(findCharacterAnchor(spoken, "c'est une très bonne idée")?.start).toBe(0);
    expect(findCharacterAnchor(spoken, "très bonne idée")?.firstEnd).toBe(spoken.indexOf("très") + "très".length);
    expect(findCharacterAnchor(spoken, "part")).toBeNull();
    expect(findCharacterAnchor(spoken, "party")).not.toBeNull();
  });

  it("emits one immediate nonverbal cue when the first beat has an empty anchor", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-immediate");

    const immediate = performer.accept(performance([
      beat({ anchor: "", expression: "surprised", gesture: "lift", intent: "react" }),
      beat({ anchor: "That makes sense.", expression: "curious", intent: "acknowledge" }),
    ]), "call-immediate");

    expect(immediate).toMatchObject({
      id: "voice-character:turn-immediate:call-immediate:0",
      turnId: "turn-immediate",
      source: "user",
      kind: "reaction",
      expression: "surprised",
      gesture: "lift",
      phraseIndex: 0,
    });
    expect(immediate).not.toHaveProperty("anchor");
    expect(performer.hasPlan).toBe(true);
    expect(performer.hasActiveBeat).toBe(true);
  });

  it("gates an anchored beat on audible playback, but accepts an anticipated early cursor", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-early");
    performer.accept(performance([beat({ anchor: "I’m sorry." })]), "call-early");
    const text = "I’m sorry to hear that.";
    const firstEnd = findCharacterAnchor(text, "I’m sorry.")!.firstEnd;

    expect(performer.release({
      text,
      presentedChars: firstEnd - 1,
      anticipatedChars: firstEnd - 1,
      complete: false,
      audible: false,
    })).toEqual([]);
    expect(performer.hasActiveBeat).toBe(false);
    expect(performer.release({
      text,
      presentedChars: firstEnd - 1,
      anticipatedChars: firstEnd - 1,
      complete: false,
      audible: true,
    })).toEqual([]);

    const cue = performer.release({
      text,
      presentedChars: firstEnd - 1,
      anticipatedChars: firstEnd,
      complete: false,
      audible: true,
    });
    expect(cue).toHaveLength(1);
    expect(cue[0]).toMatchObject({ anchor: "I’m sorry.", kind: "speech" });
    expect(performer.hasActiveBeat).toBe(true);
  });

  it("does not mark a scheduled performance active for future or unmatched anchors", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-not-yet-visible");
    performer.accept(performance([
      beat({ anchor: "A future thought.", expression: "curious" }),
    ]), "call-not-yet-visible");

    expect(performer.hasPlan).toBe(true);
    expect(performer.hasActiveBeat).toBe(false);
    expect(performer.release({
      text: "A different thought.",
      presentedChars: "A different thought.".length,
      anticipatedChars: "A different thought.".length,
      complete: true,
      audible: true,
    })).toEqual([]);
    expect(performer.hasActiveBeat).toBe(false);
  });

  it("clears active rendered-beat truth on reset", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-reset-active");
    expect(performer.accept(performance([
      beat({ anchor: "", expression: "surprised" }),
    ]), "call-reset-active")).not.toBeNull();
    expect(performer.hasActiveBeat).toBe(true);

    performer.reset("turn-reset-next");
    expect(performer.hasPlan).toBe(false);
    expect(performer.hasActiveBeat).toBe(false);
  });

  it("releases multiple ordered phrase beats in one reply, including after a stalled frame", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-multi");
    performer.accept(performance([
      beat({ anchor: "I’m so sorry.", expression: "concerned", intent: "comfort" }),
      beat({ anchor: "That really sucks.", expression: "sad", intent: "react" }),
      beat({ anchor: "How do you feel?", expression: "curious", intent: "question" }),
    ]), "call-multi");

    const text = "I’m so sorry. That really sucks. How do you feel?";
    const first = findCharacterAnchor(text, "I’m so sorry.")!;
    const second = findCharacterAnchor(text, "That really sucks.")!;
    const third = findCharacterAnchor(text, "How do you feel?")!;

    expect(performer.release({
      text,
      presentedChars: first.firstEnd,
      anticipatedChars: first.firstEnd,
      complete: false,
      audible: true,
    })[0]).toMatchObject({ anchor: "I’m so sorry." });

    // A frame can stall with the full transcript already known. The next
    // audible cursor should release only the newest eligible beat, not replay
    // the first one or race through an animation backlog.
    const afterStall = performer.release({
      text,
      presentedChars: third.start - 1,
      anticipatedChars: third.firstEnd,
      complete: false,
      audible: true,
    });
    expect(afterStall).toHaveLength(1);
    expect(afterStall[0]).toMatchObject({ anchor: "How do you feel?" });
    expect(second.start).toBeLessThan(third.start);
  });

  it("does not replay passed sentences or rewind when the playback cursor stalls or moves backward", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-no-rewind");
    performer.accept(performance([
      beat({ anchor: "First thought.", expression: "neutral" }),
      beat({ anchor: "Second thought.", expression: "delighted" }),
    ]), "call-no-rewind");
    const text = "First thought. Second thought.";
    const first = findCharacterAnchor(text, "First thought.")!;
    const second = findCharacterAnchor(text, "Second thought.")!;

    expect(performer.release({ text, presentedChars: first.firstEnd - 1, anticipatedChars: first.firstEnd, complete: false, audible: true })).toHaveLength(1);
    expect(performer.release({ text, presentedChars: first.firstEnd - 1, anticipatedChars: first.firstEnd, complete: false, audible: true })).toEqual([]);
    expect(performer.release({ text, presentedChars: second.firstEnd, anticipatedChars: second.firstEnd, complete: true, audible: true })[0]).toMatchObject({ anchor: "Second thought." });
    expect(performer.release({ text, presentedChars: first.firstEnd, anticipatedChars: first.firstEnd, complete: true, audible: true })).toEqual([]);
  });

  it("rejects an out-of-order later anchor without rewinding to an earlier phrase", () => {
    const performer = new VoiceCharacterPerformance();
    performer.reset("turn-order");
    performer.accept(performance([
      beat({ anchor: "Second thought.", expression: "delighted" }),
      beat({ anchor: "First thought.", expression: "concerned" }),
    ]), "call-order");
    const text = "First thought. Second thought.";
    const second = findCharacterAnchor(text, "Second thought.")!;

    const [cue] = performer.release({
      text,
      presentedChars: second.firstEnd,
      anticipatedChars: second.firstEnd,
      complete: true,
      audible: true,
    });
    expect(cue).toMatchObject({ anchor: "Second thought." });
    expect(performer.release({
      text,
      presentedChars: text.length,
      anticipatedChars: text.length,
      complete: true,
      audible: true,
    })).toEqual([]);
  });

  it("deduplicates plan acceptance, then accepts a fresh plan after reset", () => {
    const performer = new VoiceCharacterPerformance();
    const firstPlan = performance([beat({ anchor: "First thought." })]);
    const secondPlan = performance([beat({ anchor: "New thought.", expression: "curious" })]);

    performer.reset("turn-a");
    expect(performer.accept(firstPlan, "call-a")).toBeNull();
    expect(performer.accept(secondPlan, "call-duplicate")).toBeNull();
    expect(performer.hasPlan).toBe(true);

    performer.reset("turn-b");
    expect(performer.hasPlan).toBe(false);
    expect(performer.accept(secondPlan, "call-b")).toBeNull();
    const [cue] = performer.release({
      text: "New thought.",
      presentedChars: 0,
      anticipatedChars: "New thought.".length,
      complete: false,
      audible: true,
    });
    expect(cue).toMatchObject({ turnId: "turn-b", anchor: "New thought." });

    performer.reset(null);
    expect(performer.accept(firstPlan, "call-no-turn")).toBeNull();
    expect(performer.hasPlan).toBe(false);
  });
});
