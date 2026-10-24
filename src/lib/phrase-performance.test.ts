import { describe, expect, it } from "vitest";
import { expressionFields, renderAvatarExpression, type Expression } from "@bible-strong/avatar-core";
import { performanceAvatarDefinition } from "./performance-avatar";
import {
  SpeechPerformance,
  speakingPortraits,
  type FacePerformanceInput,
} from "./speech-performance";
import {
  CHARACTER_ACCENTS,
  applyCharacterAccent,
  type CharacterAccent,
} from "./character-accents";
import {
  CHARACTER_GESTURE_LIMITS,
  REST_GESTURE,
  sampleGesture,
  type CharacterGesture,
} from "./character-gestures";
import type { ReactionCue } from "./reaction-cues";
import { semanticExpressions } from "./expressions";
import type { AvatarExpression } from "../types";

type Gesture = "still" | "tilt-left" | "tilt-right" | "nod" | "lift" | "lean-in" | "settle";
type Accent = "none" | "widen" | "soften" | "squint" | "wink-left" | "wink-right" | "browless-wince" | "spark" | "glance-left" | "glance-right" | "double-blink";
type SpeechCue = ReactionCue & {
  kind?: "speech";
  gesture?: Gesture;
  phraseIndex?: number;
  accent?: Accent;
};
type CharacterFrame = ReturnType<SpeechPerformance["sample"]> & {
  body: { x: number; y: number; scale: number };
};

const allSpeech = { input: 0, output: 0.8 };

function cue(
  expression: ReactionCue["expression"],
  gesture: Gesture,
  phraseIndex: number,
  overrides: Partial<SpeechCue> = {},
): SpeechCue {
  const turnId = overrides.turnId ?? "speech-turn";
  return {
    id: `${turnId}-${phraseIndex}`,
    turnId,
    source: "assistant",
    expression,
    intensity: 0.9,
    effect: "none",
    confidence: 0.95,
    kind: "speech",
    gesture,
    phraseIndex,
    ...overrides,
  };
}

function inputFor(
  reaction: SpeechCue | null,
  changes: Partial<FacePerformanceInput> = {},
): FacePerformanceInput {
  return {
    phase: "speaking",
    expression: reaction?.expression ?? "neutral",
    activity: allSpeech,
    cue: reaction,
    ...changes,
  };
}

function frameOf(frame: ReturnType<SpeechPerformance["sample"]>): CharacterFrame {
  return frame as CharacterFrame;
}

function expressionDistance(a: Expression, b: Expression): number {
  return Math.max(...expressionFields.map((field) => {
    const scale = field.includes("Angle") ? 90 : field === "perspective" ? 2 : 120;
    return Math.abs(a[field] - b[field]) / scale;
  }));
}

function headTravel(frame: CharacterFrame): number {
  return Math.abs(frame.expression.headX)
    + Math.abs(frame.expression.headY)
    + Math.abs(frame.expression.headZ);
}

function bodyTravel(frame: CharacterFrame): number {
  return Math.abs(frame.body.x) + Math.abs(frame.body.y) + Math.abs(frame.body.scale - 1) * 8;
}

function eyeSignature(frame: CharacterFrame): string {
  const scene = renderAvatarExpression(performanceAvatarDefinition, frame.expression);
  return `${scene.geometry.leftPath}|${scene.geometry.rightPath}`;
}

function runThreePhraseTurn(reducedMotion = false) {
  const first = cue("concerned", "tilt-left", 0);
  const second = cue("concerned", "nod", 1);
  const third = cue("curious", "lean-in", 2);
  const performer = new SpeechPerformance();
  const frames = new Map<number, CharacterFrame>();

  for (let time = 0; time <= 5600; time += 16) {
    const reaction = time < 1024 ? first : time < 1920 ? second : time < 2944 ? third : null;
    const input = reaction
      ? inputFor(reaction, { reducedMotion })
      : inputFor(null, { phase: "idle", activity: { input: 0, output: 0 }, reducedMotion });
    frames.set(time, frameOf(performer.sample(input, time)));
  }

  return { first, second, third, frames };
}

function sampleAccent(accent: Accent, time = 480): CharacterFrame {
  const reaction = cue("neutral", "still", 0, { accent });
  const performer = new SpeechPerformance();
  let frame = frameOf(performer.sample(inputFor(reaction), 0));
  for (let current = 16; current <= time; current += 16) {
    frame = frameOf(performer.sample(inputFor(reaction), current));
  }
  return frame;
}

const gestures: readonly CharacterGesture[] = [
  "still", "tilt-left", "tilt-right", "nod", "lift", "lean-in", "settle",
];

const gestureKeyframeTimes: Record<CharacterGesture, number> = {
  still: 400,
  "tilt-left": 800,
  "tilt-right": 760,
  nod: 480,
  lift: 600,
  "lean-in": 1050,
  settle: 1000,
};

describe("phrase-level character performance", () => {
  it("gives each authored phrase a readable eye silhouette and a purposeful head beat", () => {
    const { frames } = runThreePhraseTurn();
    const tilt = frames.get(640)!;
    const nod = frames.get(1536)!;
    const lean = frames.get(2432)!;

    expect(eyeSignature(tilt)).not.toBe(eyeSignature(nod));
    expect(eyeSignature(nod)).not.toBe(eyeSignature(lean));
    expect(Math.abs(tilt.expression.headZ)).toBeGreaterThan(12);
    expect(bodyTravel(tilt)).toBeGreaterThan(5);
    expect(headTravel(nod)).toBeGreaterThan(0.2);
    expect(headTravel(lean)).toBeGreaterThan(0.2);
    expect(bodyTravel(lean)).toBeGreaterThan(0.2);
    expect(lean.expression.heightLeft).toBeGreaterThan(45);
    expect(lean.expression.widthLeft).toBeGreaterThan(25);
  });

  it("composes audible eye articulation onto the same phrase gesture", () => {
    const reaction = cue("concerned", "tilt-left", 0);
    const quiet = new SpeechPerformance();
    const voiced = new SpeechPerformance();
    let quietFrame = frameOf(quiet.sample(inputFor(reaction, { activity: { input: 0, output: 0.06 } }), 0));
    let voicedFrame = frameOf(voiced.sample(inputFor(reaction, { activity: { input: 0, output: 0.95 } }), 0));
    for (let time = 16; time <= 480; time += 16) {
      quietFrame = frameOf(quiet.sample(inputFor(reaction, { activity: { input: 0, output: 0.06 } }), time));
      voicedFrame = frameOf(voiced.sample(inputFor(reaction, { activity: { input: 0, output: 0.95 } }), time));
    }

    expect(voicedFrame.expression.heightLeft).toBeGreaterThan(quietFrame.expression.heightLeft);
    expect(voicedFrame.expression.heightRight).toBeGreaterThan(quietFrame.expression.heightRight);
    expect(voicedFrame.expression.headX).toBeCloseTo(quietFrame.expression.headX, 6);
    expect(voicedFrame.expression.headY).toBeCloseTo(quietFrame.expression.headY, 6);
    expect(voicedFrame.expression.headZ).toBeCloseTo(quietFrame.expression.headZ, 6);
    expect(voicedFrame.body).toEqual(quietFrame.body);
  });

  it("composes finite eye accents without changing the semantic base or head gesture", () => {
    const base = sampleAccent("none");
    const widened = sampleAccent("widen");
    const softened = sampleAccent("soften");
    const winked = sampleAccent("wink-left");

    expect(eyeSignature(widened)).not.toBe(eyeSignature(base));
    expect(eyeSignature(softened)).not.toBe(eyeSignature(base));
    expect(eyeSignature(winked)).not.toBe(eyeSignature(base));
    expect(widened.expression.heightLeft).toBeGreaterThan(base.expression.heightLeft);
    expect(softened.expression.heightLeft).toBeLessThan(base.expression.heightLeft);
    expect(winked.expression.heightLeft).toBeLessThan(base.expression.heightLeft);
    expect(widened.expression.headX).toBeCloseTo(base.expression.headX, 6);
    expect(widened.expression.headY).toBeCloseTo(base.expression.headY, 6);
    expect(widened.expression.headZ).toBeCloseTo(base.expression.headZ, 6);
    expect(widened.body).toEqual(base.body);
  });

  it("lets each eye accent expire once instead of becoming an independent loop", () => {
    const reaction = cue("neutral", "still", 0, { accent: "widen" });
    const performer = new SpeechPerformance();
    const frames = new Map<number, CharacterFrame>();
    for (let time = 0; time <= 4000; time += 16) {
      frames.set(time, frameOf(performer.sample(inputFor(reaction), time)));
    }

    const early = frames.get(480)!;
    const tail = frames.get(1600)!;
    const late = frames.get(4000)!;
    expect(early.expression.heightLeft).toBeGreaterThan(tail.expression.heightLeft);
    // A long live cue now contains authored phrase beats; the tail should be
    // stable, while it may still be settling from the final visible beat.
    expect(expressionDistance(tail.expression, late.expression)).toBeLessThan(0.06);
    expect(tail.body).toEqual(late.body);
  });

  // This exhaustively renders thousands of combinations; its aggregate runtime
  // is not a frame-time budget. Keep the separate continuity checks unchanged.
  it("keeps the full face x gesture x accent vocabulary finite and renderable", () => {
    for (const semantic of semanticExpressions) {
      for (const gesture of gestures) {
        for (const accent of CHARACTER_ACCENTS) {
          for (const elapsed of [390, gestureKeyframeTimes[gesture]]) {
            const gesturePose = sampleGesture(gesture, elapsed, REST_GESTURE);
            const base = {
              ...speakingPortraits[semantic],
              headX: gesturePose.headX,
              headY: gesturePose.headY,
              headZ: gesturePose.headZ,
            };
            const composed = applyCharacterAccent(
              base,
              0,
              accent as CharacterAccent,
              elapsed,
              0.9,
            );
            const scene = renderAvatarExpression(
              performanceAvatarDefinition,
              composed.expression,
              undefined,
              composed.openness,
            );
            const context = `${semantic}/${gesture}/${accent}@${elapsed}ms`;

            for (const field of expressionFields) {
              expect(Number.isFinite(composed.expression[field]), `${context} ${field}`).toBe(true);
            }
            expect(composed.expression.widthLeft, `${context} left width`).toBeGreaterThan(0);
            expect(composed.expression.widthRight, `${context} right width`).toBeGreaterThan(0);
            expect(composed.expression.heightLeft, `${context} left height`).toBeGreaterThan(0);
            expect(composed.expression.heightRight, `${context} right height`).toBeGreaterThan(0);
            expect(Math.abs(gesturePose.headX), `${context} headX`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
            expect(Math.abs(gesturePose.headY), `${context} headY`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
            expect(Math.abs(gesturePose.headZ), `${context} headZ`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
            expect(Math.abs(gesturePose.x), `${context} body x`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
            expect(Math.abs(gesturePose.y), `${context} body y`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
            expect(gesturePose.scale, `${context} body scale`).toBeGreaterThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMin);
            expect(gesturePose.scale, `${context} body scale`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMax);
            expect(`${scene.geometry.leftPath}|${scene.geometry.rightPath}`, context).not.toMatch(/NaN|undefined/iu);
          }
        }
      }
    }
  }, 15_000);

  it("keeps head and body gestures human-sized and finite", () => {
    const { frames } = runThreePhraseTurn();
    for (const [time, frame] of frames) {
      expect(Math.abs(frame.expression.headX), `headX at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
      expect(Math.abs(frame.expression.headY), `headY at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
      expect(Math.abs(frame.expression.headZ), `headZ at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.head);
      expect(Math.abs(frame.body.x), `body x at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
      expect(Math.abs(frame.body.y), `body y at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.body);
      expect(frame.body.scale, `body scale at ${time}ms`).toBeGreaterThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMin);
      expect(frame.body.scale, `body scale at ${time}ms`).toBeLessThanOrEqual(CHARACTER_GESTURE_LIMITS.scaleMax);
    }
  });

  it("uses a deliberately bold authored endpoint instead of hiding behind yesterday's cap", () => {
    const tilt = sampleGesture("tilt-left", 800, REST_GESTURE);
    const nod = sampleGesture("nod", 320, REST_GESTURE);

    expect(Math.abs(tilt.headZ)).toBeGreaterThan(30);
    expect(Math.abs(tilt.x)).toBeGreaterThan(20);
    expect(Math.abs(nod.headX)).toBeGreaterThan(15);
    expect(Math.abs(nod.y)).toBeGreaterThan(20);
  });

  it("retargets between clauses from the visible pose without a reset", () => {
    const first = cue("concerned", "tilt-left", 0);
    const second = cue("concerned", "nod", 1);
    const performer = new SpeechPerformance();
    const firstInput = inputFor(first);
    for (let time = 0; time <= 1008; time += 16) performer.sample(firstInput, time);
    const before = frameOf(performer.sample(firstInput, 1008));
    const sameTime = frameOf(performer.sample(inputFor(second), 1008));

    expect(sameTime.expression).toEqual(before.expression);
    expect(sameTime.body).toEqual(before.body);
    expect(sameTime.openness).toBe(before.openness);

    const next = frameOf(performer.sample(inputFor(second), 1024));
    expect(expressionDistance(next.expression, sameTime.expression)).toBeLessThan(0.08);
    expect(Math.abs(next.body.x - sameTime.body.x)).toBeLessThan(1.2);
    expect(Math.abs(next.body.y - sameTime.body.y)).toBeLessThan(1.2);
    expect(Math.abs(next.body.scale - sameTime.body.scale)).toBeLessThan(0.03);
  });

  it("settles after the final authored gesture instead of repeating forever", () => {
    const { frames } = runThreePhraseTurn();
    const tailA = frames.get(4096)!;
    const tailB = frames.get(5600)!;

    expect(bodyTravel(tailA)).toBeLessThan(0.25);
    expect(headTravel(tailA)).toBeLessThan(0.25);
    expect(bodyTravel(tailB)).toBeLessThan(0.25);
    expect(headTravel(tailB)).toBeLessThan(0.25);
    expect(expressionDistance(tailA.expression, tailB.expression)).toBeLessThan(0.035);
    expect(expressionDistance(tailB.expression, speakingPortraits.neutral)).toBeLessThan(0.08);
  });

  it("does not launch a speech gesture while assistant output is silent", () => {
    const reaction = cue("concerned", "tilt-left", 0);
    const performer = new SpeechPerformance();
    const input = inputFor(reaction, { activity: { input: 0, output: 0 } });
    let frame = frameOf(performer.sample(input, 0));
    let maxHead = headTravel(frame);
    let maxBody = bodyTravel(frame);
    for (let time = 16; time <= 3200; time += 16) {
      frame = frameOf(performer.sample(input, time));
      maxHead = Math.max(maxHead, headTravel(frame));
      maxBody = Math.max(maxBody, bodyTravel(frame));
    }

    expect(frame.beat).toBe("speaking");
    expect(frame.effect).toBeNull();
    expect(maxHead).toBeLessThan(0.05);
    expect(maxBody).toBeLessThan(0.05);
  });

  it("reduces head/body travel for reduced motion without flattening the eye expression", () => {
    const reaction = cue("concerned", "tilt-left", 0);
    const normal = new SpeechPerformance();
    const reduced = new SpeechPerformance();
    let normalFrame = frameOf(normal.sample(inputFor(reaction), 0));
    let reducedFrame = frameOf(reduced.sample(inputFor(reaction, { reducedMotion: true }), 0));
    for (let time = 16; time <= 800; time += 16) {
      normalFrame = frameOf(normal.sample(inputFor(reaction), time));
      reducedFrame = frameOf(reduced.sample(inputFor(reaction, { reducedMotion: true }), time));
    }

    const normalTravel = headTravel(normalFrame) + bodyTravel(normalFrame);
    const reducedTravel = headTravel(reducedFrame) + bodyTravel(reducedFrame);
    expect(normalTravel).toBeGreaterThan(0.2);
    expect(reducedTravel).toBeLessThan(normalTravel * 0.8 + 0.1);
    expect(reducedFrame.expression.heightLeft).toBeGreaterThan(40);
    expect(reducedFrame.expression.widthLeft).toBeGreaterThan(25);
  });

  it("keeps effects off negative reactions even when a cue asks for one", () => {
    const reaction = cue("angry", "still", 0, {
      id: "negative-effect-cue",
      turnId: "negative-effect-turn",
      effect: "confetti",
    });
    const performer = new SpeechPerformance();
    let frame = frameOf(performer.sample(inputFor(reaction), 0));
    for (let time = 16; time <= 1200; time += 16) frame = frameOf(performer.sample(inputFor(reaction), time));
    expect(frame.effect).toBeNull();
  });
});
