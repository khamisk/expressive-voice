import { describe, expect, it } from "vitest";
import { parseCharacterPerformance } from "./embodied-character";
import { sampleEffect } from "./reaction-effects";
import type { ReactionCue, ReactionEffect } from "./reaction-cues";
import { SpeechPerformance, type FacePerformanceInput } from "./speech-performance";
import { VoiceCharacterPerformance } from "./voice-character";

const moments: { effect: ReactionEffect; expression: ReactionCue["expression"] }[] = [
  { effect: "confetti", expression: "delighted" },
  { effect: "sparkle", expression: "playful" },
  { effect: "heart", expression: "relieved" },
  { effect: "question", expression: "confused" },
  { effect: "idea", expression: "curious" },
  { effect: "pop", expression: "surprised" },
  { effect: "laugh", expression: "amused" },
  { effect: "anger", expression: "angry" },
];

function plan(expression: ReactionCue["expression"], effect: ReactionEffect, anchor = "") {
  return parseCharacterPerformance(JSON.stringify({
    silent: false,
    beats: [{ expression, effect, anchor, intensity: 0.95,
      gesture: "lift", accent: "widen", intent: "react" }],
  }));
}

describe("native voice to visible reaction effects", () => {
  it.each(moments)("delivers $effect through the actual parser, scheduler, and renderer once", ({ effect, expression }) => {
    const parsed = plan(expression, effect);
    expect(parsed).not.toBeNull();
    const scheduler = new VoiceCharacterPerformance();
    scheduler.reset(`delivery-${effect}`);
    const cue = scheduler.accept(parsed!, `call-${effect}`)!;
    expect(cue.effect).toBe(effect);

    const performer = new SpeechPerformance();
    const input: FacePerformanceInput = {
      phase: "thinking", expression, cue, activity: { input: 0, output: 0 },
    };
    const effectIds = new Set<string>();
    let firstVisibleAt = Infinity;
    let lastVisibleAt = 0;
    for (let time = 0; time <= 5000; time += 16) {
      const frame = performer.sample(input, time);
      if (frame.effect) effectIds.add(frame.effect.id);
      if (sampleEffect(frame.effect, time).some(particle => particle.opacity > 0.05)) {
        firstVisibleAt = Math.min(firstVisibleAt, time);
        lastVisibleAt = time;
      }
    }
    expect(effectIds.size).toBe(1);
    expect(firstVisibleAt).toBeLessThan(400);
    expect(lastVisibleAt).toBeLessThan(2400);
    expect(lastVisibleAt).toBeGreaterThan(800);
    expect(performer.sample(input, 5016).effect).toBeNull();
  });

  it("starts an anchored effect with the spoken phrase, not on transcript arrival", () => {
    const scheduler = new VoiceCharacterPerformance();
    scheduler.reset("spoken-win");
    expect(scheduler.accept(plan("delighted", "confetti", "You got it")!, "spoken-call")).toBeNull();
    const text = "You got it!";
    expect(scheduler.release({ text, presentedChars: 0, anticipatedChars: text.length,
      complete: true, audible: false })).toEqual([]);
    const [cue] = scheduler.release({ text, presentedChars: 0, anticipatedChars: 3,
      complete: true, audible: true });
    expect(cue).toMatchObject({ kind: "speech", effect: "confetti" });
    const performer = new SpeechPerformance();
    const input: FacePerformanceInput = { phase: "speaking", expression: "delighted", cue,
      activity: { input: 0, output: 0.7 } };
    let visible = false;
    for (let time = 0; time <= 800; time += 16) {
      const frame = performer.sample(input, time);
      visible ||= sampleEffect(frame.effect, time).some(particle => particle.opacity > 0.05);
    }
    expect(visible).toBe(true);
    expect(scheduler.release({ text, presentedChars: 4, anticipatedChars: 8,
      complete: true, audible: true })).toEqual([]);
  });

  it.each(moments)("does not decorate vulnerable news with $effect", ({ effect }) => {
    expect(plan("concerned", effect)?.beats[0].effect).toBe("none");
    expect(plan("sad", effect)?.beats[0].effect).toBe("none");
  });

  it("keeps the anger mark exclusive to angry and frustrated faces", () => {
    expect(plan("angry", "anger")?.beats[0].effect).toBe("anger");
    expect(plan("frustrated", "anger")?.beats[0].effect).toBe("anger");
    expect(plan("amused", "anger")?.beats[0].effect).toBe("none");
  });

  it("lets an explicit gallery replay bypass only the live-turn cooldown", () => {
    const scheduler = new VoiceCharacterPerformance();
    scheduler.reset("preview-first");
    const first = scheduler.accept(plan("delighted", "confetti")!, "preview-first")!;
    scheduler.reset("preview-second");
    const second = scheduler.accept(plan("delighted", "confetti")!, "preview-second")!;
    const performer = new SpeechPerformance();
    const input: FacePerformanceInput = { phase: "listening", expression: "delighted",
      activity: { input: 0, output: 0 }, cue: first, effectPreview: true };
    for (let time = 0; time <= 400; time += 16) performer.sample(input, time);
    let frame = performer.sample({ ...input, cue: second }, 416);
    for (let time = 432; time <= 640; time += 16) frame = performer.sample({ ...input, cue: second }, time);
    expect(frame.effect?.id).toBe("preview-second:effect");
    const none = { ...second, id: "preview-none", effect: "none" as const };
    for (let time = 656; time <= 960; time += 16) frame = performer.sample({ ...input, cue: none }, time);
    expect(sampleEffect(frame.effect, 960).every(particle => particle.opacity === 0)).toBe(true);
  });

  it("previews any gallery effect on neutral without allowing it in a live neutral turn", () => {
    const neutralCue: ReactionCue = {
      id: "neutral-heart-cue",
      turnId: "neutral-heart-turn",
      source: "assistant",
      expression: "neutral",
      intensity: 0.95,
      effect: "heart",
      confidence: 0.95,
      kind: "reaction",
      gesture: "still",
      accent: "none",
    };
    const live = new SpeechPerformance();
    let liveFrame = live.sample({
      phase: "speaking",
      expression: "neutral",
      cue: neutralCue,
      activity: { input: 0, output: 0.8 },
    }, 0);
    for (let time = 16; time <= 1200; time += 16) {
      liveFrame = live.sample({
        phase: "speaking",
        expression: "neutral",
        cue: neutralCue,
        activity: { input: 0, output: 0.8 },
      }, time);
      expect(liveFrame.effect).toBeNull();
    }

    const preview = new SpeechPerformance();
    const previewFrame = preview.sample({
      phase: "speaking",
      expression: "neutral",
      cue: neutralCue,
      effectPreview: true,
      previewEffect: { id: "neutral-gallery-heart", kind: "heart" },
      activity: { input: 0, output: 0 },
    }, 0);
    expect(previewFrame.effect?.id).toBe("neutral-gallery-heart");
  });

  it("keeps a laugh in the amused silhouette instead of inserting skepticism", () => {
    const scheduler = new VoiceCharacterPerformance();
    scheduler.reset("warm-laugh");
    const cue = scheduler.accept(plan("amused", "laugh")!, "warm-laugh")!;
    const performer = new SpeechPerformance();
    const input: FacePerformanceInput = { phase: "listening", expression: "amused",
      activity: { input: 0, output: 0 },
      cue: { ...cue, variant: "amused-present", gesture: "still", accent: "none" } };
    let peak = 0;
    let peakFrame = performer.sample(input, 0);
    let reopened = peakFrame;
    for (let time = 0; time <= 1800; time += 16) {
      const frame = performer.sample(input, time);
      if (frame.smile > peak) {
        peak = frame.smile;
        peakFrame = frame;
      }
      reopened = frame;
      if (time >= 400) {
        expect(frame.expression.heightLeft / frame.expression.heightRight).toBeGreaterThan(0.6);
        expect(frame.expression.heightLeft / frame.expression.heightRight).toBeLessThan(1.4);
      }
    }

    expect(peak).toBeGreaterThan(0.8);
    expect(peakFrame.expression.heightLeft).toBeLessThan(45);
    expect(peakFrame.expression.heightRight).toBeLessThan(45);
    expect(peakFrame.expression.heightLeft / peakFrame.expression.heightRight).toBeLessThan(1.4);
    // A laugh is a short beat, not a face held shut for the rest of the turn.
    expect(reopened.expression.heightLeft).toBeGreaterThan(60);
    expect(reopened.expression.heightRight).toBeGreaterThan(60);
    expect(reopened.smile).toBeLessThan(peak * 0.55);
  });
});
