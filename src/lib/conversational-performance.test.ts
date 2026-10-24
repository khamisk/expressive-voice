import { describe, expect, it } from "vitest";
import { renderAvatarExpression } from "@bible-strong/avatar-core";
import { performanceAvatarDefinition } from "./performance-avatar";
import { SpeechPerformance, type FacePerformanceInput } from "./speech-performance";
import type { ReactionCue } from "./reaction-cues";

function speechCue(overrides: Partial<ReactionCue> = {}): ReactionCue {
  return {
    id: "long-thought-cue",
    turnId: "long-thought-turn",
    source: "assistant",
    expression: "neutral",
    intensity: 0.95,
    effect: "none",
    confidence: 0.95,
    kind: "speech",
    ...overrides,
  };
}

function signature(frame: ReturnType<SpeechPerformance["sample"]>): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, frame.expression, undefined, frame.openness);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

describe("conversational character delivery", () => {
  it("uses an intent-fitting head beat when a speech cue omits its gesture", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({ expression: "surprised", intent: "react" });
    const input: FacePerformanceInput = {
      phase: "speaking",
      expression: "surprised",
      cue,
      activity: { input: 0, output: 0.8, wordTick: 0, phraseTick: 0 },
    };

    const first = performer.sample(input, 0);
    const settled = performer.sample(input, 360);

    expect(first.gesture).toBe("lift");
    expect(settled.gesture).toBe("lift");
    expect(Math.abs(settled.expression.headX) + Math.abs(settled.body.y)).toBeGreaterThan(1);
  });

  it("keeps an explicit still cue still across later phrases", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({ expression: "surprised", gesture: "still", intent: "react" });
    const frame = (time: number, wordTick: number, phraseTick: number) => performer.sample({
      phase: "speaking",
      expression: "surprised",
      cue,
      activity: { input: 0, output: 0.8, wordTick, phraseTick },
    }, time);

    frame(0, 0, 0);
    const later = frame(2_000, 8, 1);
    expect(later.gesture).toBe("still");
    expect(Math.abs(later.expression.headX) + Math.abs(later.expression.headY) + Math.abs(later.expression.headZ)).toBeLessThan(0.01);
    expect(Math.abs(later.body.x) + Math.abs(later.body.y)).toBeLessThan(0.01);
  });

  it("hands a long anchored reply to fresh phrase gestures after the first gesture settles", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({
      variant: "neutral-present",
      gesture: "tilt-left",
      intent: "explain",
    });
    const frame = (time: number, wordTick: number, phraseTick: number) => performer.sample({
      phase: "speaking",
      expression: "neutral",
      cue,
      activity: { input: 0, output: 0.8, wordTick, phraseTick },
    }, time);

    const first = frame(0, 0, 0);
    const held = frame(1_000, 4, 0);
    const sameTimeWord = frame(1_000, 5, 0);
    const second = frame(1_800, 7, 1);
    const secondMoving = frame(1_816, 7, 1);
    const third = frame(3_600, 15, 2);
    const thirdMoving = frame(3_616, 15, 2);

    expect(first.gesture).toBe("tilt-left");
    expect(held.gesture).toBe("tilt-left");
    expect(sameTimeWord.expression).toEqual(held.expression);
    expect(sameTimeWord.body).toEqual(held.body);
    expect(second.gesture).toBe("lean-in");
    expect(third.gesture).toBe("settle");
    expect(Math.max(
      Math.abs(secondMoving.expression.headX - second.expression.headX),
      Math.abs(secondMoving.expression.headZ - second.expression.headZ),
      Math.abs(secondMoving.body.x - second.body.x),
    )).toBeGreaterThan(0.005);
    expect(Math.max(
      Math.abs(thirdMoving.expression.headX - third.expression.headX),
      Math.abs(thirdMoving.expression.headZ - third.expression.headZ),
      Math.abs(thirdMoving.body.x - third.body.x),
    )).toBeGreaterThan(0.005);
    expect(new Set([signature(first), signature(second), signature(third)]).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps the later phrase gesture through intervening word ticks", () => {
    const performer = new SpeechPerformance();
    const cue = speechCue({
      variant: "neutral-present",
      gesture: "tilt-left",
      intent: "explain",
    });
    const frames: Array<ReturnType<SpeechPerformance["sample"]>> = [];
    for (let time = 0; time <= 3_200; time += 16) {
      frames.push(performer.sample({
        phase: "speaking",
        expression: "neutral",
        cue,
        activity: {
          input: 0,
          output: 0.8,
          wordTick: Math.floor(time / 240),
          phraseTick: time < 2_000 ? 0 : 1,
        },
      }, time));
    }

    const atPhrase = frames[2_016 / 16];
    const afterWord = frames[2_160 / 16];
    const laterWord = frames[2_400 / 16];
    expect(atPhrase.gesture).toBe("lean-in");
    expect(afterWord.gesture).toBe("lean-in");
    expect(laterWord.gesture).toBe("lean-in");
    expect(Math.abs(afterWord.expression.headZ) + Math.abs(afterWord.body.x)).toBeGreaterThan(2);
    expect(Math.abs(laterWord.expression.headZ) + Math.abs(laterWord.body.x)).toBeGreaterThan(
      Math.abs(afterWord.expression.headZ) + Math.abs(afterWord.body.x),
    );
  });
});
