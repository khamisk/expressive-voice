import { describe, expect, it } from "vitest";
import { expressionFields, renderAvatarExpression, type Expression } from "./face-renderer";
import { performanceAvatarDefinition } from "./performance-avatar";
import {
  EFFECT_COOLDOWN_MS,
  SpeechPerformance,
  phraseFace,
  speakingPortraits,
  type FacePerformanceInput,
} from "./speech-performance";
import { sampleEffect } from "./reaction-effects";
import type { ReactionCue } from "./reaction-cues";
import type { AvatarExpression } from "../types";

const speaking: FacePerformanceInput = {
  phase: "speaking",
  expression: "neutral",
  activity: { input: 0, output: 0 },
};

function cue(
  expression: ReactionCue["expression"],
  overrides: Partial<ReactionCue> = {},
): ReactionCue {
  return {
    id: `${overrides.turnId ?? "turn-1"}-cue`,
    turnId: "turn-1",
    source: "assistant",
    expression,
    intensity: 0.9,
    effect: "none",
    confidence: 0.95,
    ...overrides,
  };
}

function numericDistance(a: Expression, b: Expression): number {
  return Math.max(...expressionFields.map((field) => {
    const scale = field.includes("Angle") ? 90 : field === "perspective" ? 2 : 120;
    return Math.abs(a[field] - b[field]) / scale;
  }));
}

function expressionSignature(expression: Expression): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, expression);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

function withCue(
  reaction: ReactionCue,
  changes: Partial<FacePerformanceInput> = {},
): FacePerformanceInput {
  return {
    phase: "speaking",
    expression: reaction.expression,
    activity: { input: 0, output: 0.8 },
    cue: reaction,
    ...changes,
  };
}

describe("character performance contract", () => {
  it("keeps neutral physically still and bounds authored head gestures", () => {
    expect(speakingPortraits.neutral.headX).toBe(0);
    expect(speakingPortraits.neutral.headY).toBe(0);
    expect(speakingPortraits.neutral.headZ).toBe(0);
    for (const [name, portrait] of Object.entries(speakingPortraits)) {
      expect(Math.abs(portrait.headX), name).toBeLessThanOrEqual(16);
      expect(Math.abs(portrait.headY), name).toBeLessThanOrEqual(16);
      expect(Math.abs(portrait.headZ), name).toBeLessThanOrEqual(16);
      expect(portrait.eyeMotion, name).toBe("none");
      expect(portrait.bodyMotion, name).toBe("none");
    }
  });

  it("does not infer a semantic mood or effect from assistant audio alone", () => {
    const first = new SpeechPerformance();
    const second = new SpeechPerformance();
    first.sample(speaking, 0);
    second.sample(speaking, 0);

    const louder = first.sample({ ...speaking, activity: { input: 0, output: 0.95 } }, 320);
    const sameAudio = second.sample({ ...speaking, activity: { input: 0, output: 0.95 } }, 320);

    expect(louder.beat).toBe("speaking");
    expect(louder.effect).toBeNull();
    expect(louder.smile).toBe(0);
    expect(louder.expression).toEqual(sameAudio.expression);
    expect(louder.expression.headX).toBe(0);
    expect(louder.expression.headY).toBe(0);
    expect(louder.expression.headZ).toBe(0);
    expect(louder.expression.heightLeft).toBeLessThan(speakingPortraits.neutral.heightLeft + 20);
    expect(louder.expression.heightRight).toBeLessThan(speakingPortraits.neutral.heightRight + 20);
  });

  it("uses distinct eye silhouettes instead of pretending movement is expression", () => {
    const featured: AvatarExpression[] = [
      "neutral",
      "curious",
      "surprised",
      "amused",
      "delighted",
      "concerned",
      "playful",
      "relieved",
    ];
    const signatures = featured.map((name) => expressionSignature(speakingPortraits[name]));

    expect(new Set(signatures).size).toBe(featured.length);
    expect(speakingPortraits.curious.heightLeft / speakingPortraits.curious.heightRight).toBeGreaterThan(1.45);
    expect(speakingPortraits.surprised.widthLeft).toBeGreaterThan(50);
    // Amused is open and attentive at rest. Its laugh closes briefly as an
    // earned beat; the resting silhouette itself should still be substantial.
    expect(speakingPortraits.amused.widthLeft).toBeGreaterThanOrEqual(44);
    expect(speakingPortraits.amused.heightLeft).toBeGreaterThanOrEqual(60);
    expect(speakingPortraits.delighted.heightLeft).toBeGreaterThan(75);
    expect(speakingPortraits.concerned.positionYLeft).toBeGreaterThan(6);
    expect(speakingPortraits.playful.heightRight).toBeLessThan(30);
    // Relief also rests open; its softer meaning comes from the pose and
    // eventual smile beat, not permanently closed eyes.
    expect(speakingPortraits.relieved.heightLeft).toBeGreaterThanOrEqual(60);
  });

  it("plays a recognition beat once, then holds instead of looping a reaction", () => {
    const reaction = cue("delighted", { source: "user", turnId: "user-1", id: "user-1-cue" });
    const performer = new SpeechPerformance();
    const input = withCue(reaction, {
      phase: "listening",
      activity: { input: 0.45, output: 0 },
    });
    const framesByTime = new Map<number, ReturnType<typeof performer.sample>>();
    const sampleTimes = [0, 320, 640, 1088, 2000, 2800, 4192, 6000];
    for (let time = 0; time <= 6000; time += 16) {
      const frame = performer.sample(input, time);
      if (sampleTimes.includes(time)) framesByTime.set(time, frame);
    }
    const frames = sampleTimes
      .map((time) => framesByTime.get(time)!);
    const beats = frames.map((frame) => frame.beat);

    expect(beats[0]).toBe("recognize");
    expect(beats).toContain("light-up");
    expect(beats).toContain("warm-hold");
    expect(beats).toContain("soften");
    expect(beats.slice(-3)).not.toContain("recognize");
    expect(numericDistance(frames[5].expression, frames[6].expression)).toBeLessThan(0.035);
    expect(numericDistance(frames[6].expression, frames[7].expression)).toBeLessThan(0.035);
  });

  it("retargets from the visible pose with no same-time jump and bounded 60fps deltas", () => {
    const performer = new SpeechPerformance();
    const active: FacePerformanceInput = {
      phase: "speaking",
      expression: "surprised",
      activity: { input: 0, output: 0.8 },
    };
    performer.sample(active, 0);
    for (let time = 16; time <= 960; time += 16) performer.sample(active, time);
    const before = performer.sample(active, 960);
    const reversal = cue("sad", { id: "assistant-2-cue", turnId: "assistant-2" });
    const sameTime = performer.sample(withCue(reversal), 960);

    expect(sameTime.expression).toEqual(before.expression);
    expect(sameTime.smile).toBe(before.smile);
    expect(sameTime.openness).toBe(before.openness);

    const next = performer.sample(withCue(reversal), 976);
    expect(numericDistance(next.expression, sameTime.expression)).toBeLessThan(0.08);

    const secondReversal = cue("curious", { id: "assistant-3-cue", turnId: "assistant-3" });
    const secondSameTime = performer.sample(withCue(secondReversal), 976);
    expect(secondSameTime.expression).toEqual(next.expression);
    expect(secondSameTime.smile).toBe(next.smile);
    expect(numericDistance(
      performer.sample(withCue(secondReversal), 992).expression,
      secondSameTime.expression,
    )).toBeLessThan(0.08);
  });

  it("does not start an assistant reaction or effect while its output is silent", () => {
    const reaction = cue("delighted", {
      id: "silent-cue",
      turnId: "silent-turn",
      effect: "confetti",
    });
    const performer = new SpeechPerformance();
    const input = withCue(reaction, {
      expression: "neutral",
      activity: { input: 0, output: 0 },
    });

    let frame = performer.sample(input, 0);
    for (let time = 16; time <= 3200; time += 16) frame = performer.sample(input, time);

    expect(frame.beat).toBe("speaking");
    expect(frame.effect).toBeNull();
    expect(frame.expression).toEqual(speakingPortraits.neutral);
  });

  it("shows a completed user reaction before assistant output begins", () => {
    const reaction = cue("delighted", {
      id: "user-recognition-cue",
      turnId: "user-recognition",
      source: "user",
      effect: "confetti",
    });
    const performer = new SpeechPerformance();
    const input = withCue(reaction, {
      phase: "thinking",
      activity: { input: 0, output: 0 },
    });
    const neutralHeight = speakingPortraits.neutral.heightLeft;
    let semanticAt = Infinity;
    let effectAt = Infinity;
    for (let time = 0; time <= 400; time += 16) {
      const frame = performer.sample(input, time);
      if (semanticAt === Infinity && frame.expression.heightLeft > neutralHeight + 4) semanticAt = time;
      if (effectAt === Infinity && frame.effect) effectAt = time;
    }

    expect(semanticAt).toBeLessThanOrEqual(160);
    expect(effectAt).toBeLessThanOrEqual(200);
  });

  it("allows one small effect per eligible turn and enforces the cooldown", () => {
    const firstReaction = cue("delighted", {
      id: "positive-1-cue",
      turnId: "positive-1",
      effect: "confetti",
    });
    const performer = new SpeechPerformance();
    const firstInput = withCue(firstReaction);
    const effectFrames = [];
    for (let time = 0; time <= 1100; time += 16) {
      const frame = performer.sample(firstInput, time);
      if (frame.effect) effectFrames.push(frame);
    }

    expect(effectFrames.length).toBeGreaterThan(0);
    expect(new Set(effectFrames.map((frame) => frame.effect!.id))).toEqual(new Set(["positive-1:effect"]));
    expect(sampleEffect(effectFrames[0].effect, effectFrames[0].effect!.startedAt)).toHaveLength(4);

    const duplicateCue = cue("delighted", {
      id: "positive-1-cue-reissued",
      turnId: "positive-1",
      effect: "confetti",
    });
    expect(performer.sample(withCue(duplicateCue), 3000).effect).toBeNull();

    const nextTurn = cue("delighted", {
      id: "positive-2-cue",
      turnId: "positive-2",
      effect: "sparkle",
    });
    expect(performer.sample(withCue(nextTurn), 2000).effect).toBeNull();

    const afterCooldown = performer.sample(withCue(nextTurn), 2000 + EFFECT_COOLDOWN_MS + 100);
    expect(afterCooldown.effect?.id).toBe("positive-2:effect");
    expect(sampleEffect(afterCooldown.effect, afterCooldown.effect!.startedAt)).toHaveLength(4);
  });

  it("matches the effect choreography to the semantic moment", () => {
    const unsafe = cue("surprised", {
      id: "surprised-win-cue",
      turnId: "surprised-win",
      effect: "confetti",
    });
    const safeSpark = cue("surprised", {
      id: "surprised-spark-cue",
      turnId: "surprised-spark",
      effect: "sparkle",
    });
    const warmHeart = cue("relieved", {
      id: "relieved-heart-cue",
      turnId: "relieved-heart",
      effect: "heart",
    });
    const actualQuestion = cue("confused", {
      id: "confused-question-cue",
      turnId: "confused-question",
      effect: "question",
    });
    const solvedIdea = cue("neutral", {
      id: "neutral-idea-cue",
      turnId: "neutral-idea",
      effect: "idea",
    });

    const run = (reaction: ReactionCue) => {
      const performer = new SpeechPerformance();
      let frame = performer.sample(withCue(reaction), 0);
      for (let time = 16; time <= 1200; time += 16) frame = performer.sample(withCue(reaction), time);
      return frame;
    };

    expect(run(unsafe).effect).toBeNull();
    expect(run(safeSpark).effect?.kind).toBe("sparkle");
    expect(run(warmHeart).effect?.kind).toBe("heart");
    expect(run(actualQuestion).effect?.kind).toBe("question");
    expect(run(solvedIdea).effect?.kind).toBe("idea");
  });

  it("retires an active celebration when the same turn pivots to hostility", () => {
    for (const effect of ["confetti", "sparkle"] as const) {
      const performer = new SpeechPerformance();
      const celebration = cue("delighted", {
        id: `shared-turn-${effect}`,
        turnId: "shared-turn",
        effect,
      });

      let active = performer.sample(withCue(celebration), 0);
      for (let time = 16; time <= 900; time += 16) active = performer.sample(withCue(celebration), time);
      expect(active.effect?.kind).toBe(effect);

      const hostile = cue("angry", {
        id: `shared-turn-hostile-${effect}`,
        turnId: "shared-turn",
      });
      const pivot = performer.sample(withCue(hostile), 900);
      // Retiring is deliberately a short fade, not an abrupt disappearance.
      expect(pivot.effect?.kind).toBe(effect);
      expect(performer.sample(withCue(hostile), 1081).effect).toBeNull();
    }
  });

  it("keeps word-tick microfaces inside their semantic family", () => {
    const neutralFaces = Array.from({ length: 27 }, (_, index) => phraseFace("neutral", index));
    const curiousFaces = Array.from({ length: 27 }, (_, index) => phraseFace("curious", index));
    const confusedFaces = Array.from({ length: 27 }, (_, index) => phraseFace("confused", index));
    const hostileFaces = Array.from({ length: 27 }, (_, index) => phraseFace("angry", index));
    const determinedFaces = Array.from({ length: 27 }, (_, index) => phraseFace("determined", index));

    expect(neutralFaces).not.toContain("confused");
    expect(neutralFaces).not.toContain("surprised");
    // Word/phrase counters now select same-family variants and accents; they
    // must never invent attentive, curious, or a different emotional mood
    // from a neutral semantic cue.
    expect(new Set(neutralFaces)).toEqual(new Set(["neutral"]));

    expect(curiousFaces).not.toContain("confused");
    expect(curiousFaces).not.toContain("surprised");
    expect(confusedFaces).not.toContain("surprised");

    expect(hostileFaces.some((face) => ["angry", "frustrated", "determined"].includes(face))).toBe(true);
    expect(hostileFaces).not.toContain("delighted");
    expect(hostileFaces).not.toContain("joyful");
    expect(hostileFaces).not.toContain("sad");
    expect(hostileFaces).not.toContain("concerned");

    expect(determinedFaces).not.toContain("delighted");
    expect(determinedFaces).not.toContain("joyful");
    expect(determinedFaces).not.toContain("confused");
    expect(determinedFaces).not.toContain("angry");
    expect(determinedFaces).not.toContain("frustrated");
  });

  it("rejects effects for low-confidence, negative, or vulnerable reactions", () => {
    const cases: ReactionCue[] = [
      cue("concerned", { id: "concerned-cue", turnId: "concerned", effect: "heart" }),
      cue("sad", { id: "sad-cue", turnId: "sad", effect: "confetti" }),
      cue("angry", { id: "angry-cue", turnId: "angry", effect: "confetti" }),
      cue("frustrated", { id: "frustrated-cue", turnId: "frustrated", effect: "sparkle" }),
      cue("angry", { id: "angry-idea-cue", turnId: "angry-idea", effect: "idea" }),
      cue("sad", { id: "sad-idea-cue", turnId: "sad-idea", effect: "idea" }),
      cue("delighted", { id: "low-confidence-cue", turnId: "low-confidence", effect: "confetti", confidence: 0.79 }),
      cue("delighted", { id: "low-intensity-cue", turnId: "low-intensity", effect: "confetti", intensity: 0.54 }),
    ];

    for (const reaction of cases) {
      const performer = new SpeechPerformance();
      const input = withCue(reaction);
      let frame = performer.sample(input, 0);
      for (let time = 16; time <= 1200; time += 16) frame = performer.sample(input, time);
      expect(frame.effect, reaction.id).toBeNull();
    }
  });
});
