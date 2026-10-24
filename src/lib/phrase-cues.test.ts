import { describe, expect, it } from "vitest";
import { deriveFastSpeechCue, deriveImmediateUserCue } from "./phrase-cues";

describe("low-latency streamed phrase cues", () => {
  it("keeps ordinary coffee language neutral", () => {
    const userText = "Anyway, I'm just making coffee before work.";
    const hope = deriveFastSpeechCue({
      turnId: "coffee",
      phrase: "I hope it tastes great.",
      userText,
      phraseIndex: 0,
    });
    const scallions = deriveFastSpeechCue({
      turnId: "coffee",
      phrase: "Add anything crunchy, like scallions.",
      userText,
      phraseIndex: 1,
    });

    expect(hope).toMatchObject({ expression: "neutral", intent: "explain", effect: "none", anchor: "I hope it tastes great." });
    expect(scallions).toMatchObject({ expression: "neutral", intent: "explain", effect: "none", anchor: "Add anything crunchy, like scallions." });
  });

  it("expresses the empathy clause of a mixed update without celebrating the whole turn", () => {
    const cue = deriveFastSpeechCue({
      turnId: "mixed",
      phrase: "Still feel the tug of leaving your people.",
      userText: "I got the apartment, but now I'm nervous about moving away from my friends.",
      phraseIndex: 1,
    });

    expect(cue).toMatchObject({ expression: "concerned", intent: "comfort", effect: "none", gesture: "nod", accent: "soften" });
  });

  it("recognizes a clear win but never adds a speech effect", () => {
    const cue = deriveFastSpeechCue({
      turnId: "win",
      phrase: "Congratulations on landing the job.",
      userText: "I finally got the job I really wanted!",
    });

    expect(cue).toMatchObject({ expression: "delighted", intent: "celebrate", effect: "none", gesture: "lift" });
  });

  it("allows a warm acknowledgement only when the user context earns it", () => {
    const earned = deriveFastSpeechCue({
      turnId: "earned-ack",
      phrase: "Oh, nice!",
      userText: "I finally got the job I really wanted!",
    });
    const ordinary = deriveFastSpeechCue({
      turnId: "ordinary-ack",
      phrase: "Oh, nice!",
      userText: "Anyway, I'm just making coffee before work.",
    });

    expect(earned).toMatchObject({ expression: "delighted", intent: "celebrate", effect: "none" });
    expect(ordinary).toMatchObject({ expression: "neutral", intent: "explain", effect: "none" });
  });

  it("keeps sarcastic positive words neutral when the user context is negative", () => {
    const cue = deriveFastSpeechCue({
      turnId: "crash",
      phrase: "Fantastic, just what you needed.",
      userText: "Fantastic. My laptop crashed again and I lost an hour of work.",
    });

    expect(cue).toMatchObject({ expression: "neutral", effect: "none" });
  });

  it("uses distinct grounded cues for questions, humor, and corrections", () => {
    expect(deriveFastSpeechCue({
      turnId: "question",
      phrase: "How did you get it to work?",
      userText: "I built a tiny robot.",
    })).toMatchObject({ expression: "curious", intent: "question", gesture: "lean-in", effect: "none" });

    expect(deriveFastSpeechCue({
      turnId: "joke",
      phrase: "Ha, that's a very literal teammate.",
      userText: "I told my code it needed a break, and it opened an issue.",
    })).toMatchObject({ expression: "amused", intent: "joke", accent: "spark", effect: "none" });

    expect(deriveFastSpeechCue({
      turnId: "correction",
      phrase: "Got it, next Thursday.",
      userText: "Actually, it's next Thursday, not tomorrow.",
    })).toMatchObject({ expression: "neutral", intent: "correct", gesture: "nod", accent: "glance-down", effect: "none" });
  });

  it("is deterministic for the same phrase and context", () => {
    const input = {
      turnId: "deterministic",
      phrase: "That sounds really hard.",
      userText: "I lost an hour of work.",
      phraseIndex: 2,
    };
    expect(deriveFastSpeechCue(input)).toEqual(deriveFastSpeechCue(input));
  });

  it("returns null for an empty streamed fragment", () => {
    expect(deriveFastSpeechCue({ turnId: "empty", phrase: "   " })).toBeNull();
  });

  it("varies empathy delivery across clauses without changing the concerned meaning", () => {
    const userText = "I lost my job yesterday and I don't know what to do.";
    const phrases = [
      "I'm so sorry to hear that.",
      "That really sucks.",
      "You put so much into this.",
    ];
    const cues = phrases.map((phrase, phraseIndex) => deriveFastSpeechCue({
      turnId: "empathy-sequence",
      phrase,
      userText,
      phraseIndex,
    }));

    expect(cues.every((cue) => cue?.expression === "concerned")).toBe(true);
    expect(new Set(cues.map((cue) => cue?.gesture)).size).toBe(3);
    expect(cues.map((cue) => cue?.gesture)).toEqual(["tilt-left", "nod", "settle"]);
    expect(cues.every((cue) => cue?.effect === "none")).toBe(true);
    expect(cues.some((cue) => cue?.accent === "eye-roll")).toBe(false);
  });

  it("uses held question alternatives while keeping the question curious", () => {
    const first = deriveFastSpeechCue({
      turnId: "question-sequence",
      phrase: "How did you get it to work?",
      phraseIndex: 0,
    });
    const second = deriveFastSpeechCue({
      turnId: "question-sequence",
      phrase: "What happened next?",
      phraseIndex: 1,
    });

    expect(first).toMatchObject({ expression: "curious", intent: "question", gesture: "lean-in", accent: "widen" });
    expect(second).toMatchObject({ expression: "curious", intent: "question", gesture: "tilt-right", accent: "double-take" });
  });

  it("gives long neutral explanations one intentional beat but leaves short facts still", () => {
    const longLine = deriveFastSpeechCue({
      turnId: "explanation-sequence",
      phrase: "First, open the settings panel and select your account.",
      phraseIndex: 0,
    });
    const alternate = deriveFastSpeechCue({
      turnId: "explanation-sequence",
      phrase: "Then choose the privacy option from the menu.",
      phraseIndex: 1,
    });
    const shortFact = deriveFastSpeechCue({
      turnId: "short-fact",
      phrase: "It is ready.",
      phraseIndex: 0,
    });

    expect(longLine).toMatchObject({ expression: "neutral", intent: "explain", gesture: "nod", accent: "none" });
    expect(alternate).toMatchObject({ expression: "neutral", intent: "explain", gesture: "tilt-left", accent: "glance-up" });
    expect(shortFact).toMatchObject({ expression: "neutral", intent: "explain", gesture: "still", accent: "none" });
  });
});

describe("conservative immediate user cues", () => {
  it("recognizes only explicit first-person wins", () => {
    const job = deriveImmediateUserCue({
      turnId: "job-win",
      text: "I finally got the job I really wanted!",
    });
    const exam = deriveImmediateUserCue({
      turnId: "exam-win",
      text: "I passed my final exam.",
    });
    const apartment = deriveImmediateUserCue({
      turnId: "apartment-win",
      text: "We finally landed the apartment.",
      cueId: "typed-win",
    });

    expect(job).toMatchObject({
      expression: "delighted",
      intent: "celebrate",
      effect: "confetti",
      source: "user",
      confidence: 0.97,
      anchor: "I finally got the job",
      turnId: "job-win",
    });
    expect(exam).toMatchObject({ expression: "delighted", effect: "confetti", source: "user" });
    expect(apartment).toMatchObject({ id: "typed-win", expression: "delighted", effect: "confetti" });
  });

  it("gives explicit bad news a concern cue without celebration", () => {
    for (const [index, text] of [
      "I didn't get the job after all.",
      "I got rejected from the apartment.",
      "I have bad news: my project failed.",
    ].entries()) {
      const cue = deriveImmediateUserCue({ turnId: `bad-${index}`, text });
      expect(cue).toMatchObject({ expression: "concerned", intent: "comfort", effect: "none", source: "user" });
      expect(cue?.effect).not.toBe("confetti");
    }
  });

  it("defers bittersweet wins and reversals to the richer director", () => {
    expect(deriveImmediateUserCue({
      turnId: "bittersweet",
      text: "I finally got the apartment, but I'm sad about leaving my friends.",
    })).toBeNull();
    expect(deriveImmediateUserCue({
      turnId: "bittersweet-curly",
      text: "I finally got the apartment, but I’m sad about leaving my friends.",
    })).toBeNull();
    expect(deriveImmediateUserCue({
      turnId: "sarcastic-reversal",
      text: "I got the job. Not.",
    })).toBeNull();
  });

  it("does not infer a win from ordinary, ambiguous, or question-shaped turns", () => {
    for (const [index, text] of [
      "Anyway, I'm just making coffee before work.",
      "How do I get the job application started?",
      "I got the job?",
      "I told my friend she passed her exam.",
      "If I got the job, we'd celebrate.",
      'She said, "I got the job."',
      "I got the job, just kidding.",
    ].entries()) {
      expect(deriveImmediateUserCue({ turnId: `ambiguous-${index}`, text })).toBeNull();
    }
  });

  it("requires a complete, non-empty turn while remaining deterministic", () => {
    const input = { turnId: "complete", text: "I finally shipped the project!", cueId: "complete:cue" };
    expect(deriveImmediateUserCue({ turnId: "partial", text: "I finally shipped the proj…" })).toBeNull();
    expect(deriveImmediateUserCue({ turnId: "empty", text: "   " })).toBeNull();
    expect(deriveImmediateUserCue(input)).toEqual(deriveImmediateUserCue(input));
  });
});
