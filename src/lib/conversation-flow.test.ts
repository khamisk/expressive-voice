import { describe, expect, it } from "vitest";
import { parseReactionCue } from "./reaction-cues";
import { SpeechPerformance } from "./speech-performance";

describe("contextual cue to continuous face integration", () => {
  it("can leave a celebration for concern without teleporting or retaining confetti", () => {
    const proud = parseReactionCue(JSON.stringify({ expression: "proud", intensity: 0.9, confidence: 0.96, effect: "confetti", anchor: "got the job" }), {
      id: "happy", turnId: "turn1", currentUserText: "I finally got the job!",
    })!;
    const concerned = parseReactionCue(JSON.stringify({ expression: "concerned", intensity: 0.8, confidence: 0.94, effect: "none" }), {
      id: "concerned", turnId: "turn2", currentUserText: "Actually, I'm worried about moving away.",
    })!;
    const performer = new SpeechPerformance();
    const activity = { input: 0, output: 0.5 };
    const first = { phase: "speaking" as const, expression: proud.expression, cue: proud, activity };
    for (let t = 0; t < 960; t += 16) performer.sample(first, t);
    const before = performer.sample(first, 960);
    const second = { ...first, expression: concerned.expression, cue: concerned };
    const after = performer.sample(second, 960);
    expect(after.expression).toEqual(before.expression);
    let settled = after;
    for (let t = 976; t <= 2800; t += 16) settled = performer.sample(second, t);
    expect(settled.expression.leftAngle).toBeGreaterThan(12);
    expect(settled.expression.rightAngle).toBeLessThan(-12);
    expect(settled.effect).toBeNull();
    expect(settled.smile).toBeLessThan(0.01);
  });

  it("a neutral model cue cannot launch a decorative effect", () => {
    const cue = parseReactionCue(JSON.stringify({ expression: "neutral", intensity: 0.1, confidence: 0.4, effect: "confetti", anchor: "breakfast" }), {
      id: "ordinary", turnId: "turn3", currentUserText: "What should I have for breakfast?",
    })!;
    expect(cue.effect).toBe("none");
    const performer = new SpeechPerformance();
    for (let t = 0; t < 4000; t += 16) {
      expect(performer.sample({ phase: "speaking", expression: "neutral", activity: { input: 0, output: 0.4 }, cue }, t).effect).toBeNull();
    }
  });
});
