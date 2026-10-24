import { describe, expect, it } from "vitest";
import {
  CHARACTER_ANCHOR_MAX_LENGTH,
  CHARACTER_PERFORMANCE_MAX_BEATS,
  CHARACTER_TOOL,
  CHARACTER_TOOL_NAME,
  MAX_CHARACTER_PERFORMANCE_ARGUMENT_CHARS,
  parseCharacterPerformance,
} from "./embodied-character";

const beat = (overrides: Record<string, unknown> = {}) => ({
  expression: "surprised",
  intensity: 0.9,
  anchor: "Wait, really?",
  ...overrides,
});

const performance = (beats: unknown[] = [beat()], overrides: Record<string, unknown> = {}) => ({
  silent: false,
  beats,
  ...overrides,
});

describe("embodied character contract", () => {
  it("exposes one optional auto-call tool with the bounded beat schema", () => {
    expect(CHARACTER_TOOL_NAME).toBe("perform_character");
    expect(CHARACTER_TOOL.type).toBe("function");
    expect(CHARACTER_TOOL.name).toBe(CHARACTER_TOOL_NAME);
    expect(CHARACTER_TOOL.description).toContain("meaningful moment");
    expect(CHARACTER_TOOL.description).toContain("not every sentence");
    expect(CHARACTER_TOOL.description).toContain("at most once per assistant reply");
    expect(CHARACTER_TOOL.description).toContain("not once per session");
    expect(CHARACTER_TOOL.description).toContain("plain acknowledgements and facts need no call");
    expect(CHARACTER_TOOL.description).toContain("exactly one immediate face beat");
    expect(CHARACTER_TOOL.description).toContain("silent defaults false");
    expect(CHARACTER_TOOL.description).toContain("direct face-state questions");
    expect(CHARACTER_TOOL.parameters).not.toHaveProperty("strict");
    expect(CHARACTER_TOOL.parameters.properties.beats.maxItems).toBe(CHARACTER_PERFORMANCE_MAX_BEATS);
    expect(CHARACTER_TOOL.parameters.properties.beats.minItems).toBe(1);
    expect(CHARACTER_TOOL.parameters.properties.beats.items.required).toEqual([
      "expression",
      "intensity",
      "anchor",
      "intent",
      "gesture",
      "accent",
      "effect",
    ]);
    expect(CHARACTER_TOOL.parameters.properties.beats.items.properties).toHaveProperty("gesture");
  });

  it("preserves a model-selected expression and supplies typed defaults", () => {
    const parsed = parseCharacterPerformance(JSON.stringify(performance([
      beat({ expression: "sad", intensity: 0.72, anchor: "That hurts." }),
    ])));

    expect(parsed).toEqual({
      silent: false,
      beats: [{
        expression: "sad",
        intensity: 0.72,
        anchor: "That hurts.",
        intent: "react",
        gesture: "still",
        accent: "none",
        effect: "none",
      }],
    });
  });

  it("accepts a direct explicit face request without lexical downgrading", () => {
    const parsed = parseCharacterPerformance(JSON.stringify(performance([
      beat({ expression: "angry", intensity: 1, anchor: "No, absolutely not." }),
    ])));

    expect(parsed?.beats[0]).toMatchObject({
      expression: "angry",
      intensity: 1,
      anchor: "No, absolutely not.",
    });
  });

  it("allows a silent nonverbal call only as one immediate face beat", () => {
    expect(parseCharacterPerformance(JSON.stringify({ silent: true, beats: [beat({
      expression: "skeptical",
      intensity: 0.86,
      anchor: "",
      gesture: "tilt-right",
    })] }))).toMatchObject({
      silent: true,
      beats: [{
        expression: "skeptical",
        intensity: 0.86,
        anchor: "",
        gesture: "tilt-right",
      }],
    });
    expect(parseCharacterPerformance(JSON.stringify({ silent: true, beats: [] }))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ anchor: "Look at this" })], { silent: true })))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify({
      silent: true,
      beats: [beat({ anchor: "" }), beat({ expression: "curious", anchor: "Really?" })],
    }))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([])))).toBeNull();
  });

  it("rejects missing fields, invalid enums, and extra tool properties", () => {
    expect(parseCharacterPerformance(JSON.stringify({ silent: false, beats: [{ expression: "curious", anchor: "Hmm" }] }))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ expression: "attentive" })])))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ gesture: "orbit" })])))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ madeUp: true })])))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify({ silent: false, beats: [beat()], extra: "nope" }))).toBeNull();
  });

  it("rejects non-finite and out-of-range intensity instead of clamping it", () => {
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ intensity: -0.01 })])))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ intensity: 1.01 })])))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([beat({ intensity: null })])))).toBeNull();
    expect(parseCharacterPerformance('{"silent":false,"beats":[{"expression":"curious","intensity":NaN,"anchor":"Hmm"}]}')).toBeNull();
  });

  it("requires the first beat to be the only possible immediate beat", () => {
    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ anchor: "" }),
      beat({ expression: "curious", anchor: "What happened?" }),
    ])))).not.toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ expression: "curious", anchor: "What happened?" }),
      beat({ expression: "concerned", anchor: "" }),
    ])))).toBeNull();
  });

  it("rejects duplicate anchors after whitespace/case normalization", () => {
    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ anchor: "Wait, really?" }),
      beat({ expression: "curious", anchor: "  wait,   REALLY? " }),
    ])))).toBeNull();
  });

  it("validates exact anchor presence and spoken order when text is available", () => {
    const source = "That is rough. What happened next? I am listening.";
    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ anchor: "" }),
      beat({ expression: "curious", anchor: "What happened next?" }),
      beat({ expression: "concerned", anchor: "I am listening." }),
    ])), { spokenText: source })).not.toBeNull();

    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ anchor: "" }),
      beat({ expression: "curious", anchor: "I am listening." }),
      beat({ expression: "concerned", anchor: "What happened next?" }),
    ])), { spokenText: source })).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([
      beat({ anchor: "" }),
      beat({ expression: "curious", anchor: "Not in the reply" }),
    ])), source)).toBeNull();
  });

  it("normalizes incompatible effects to none while preserving legal effects", () => {
    const parsed = parseCharacterPerformance(JSON.stringify(performance([
      beat({ expression: "sad", effect: "confetti" }),
      beat({ expression: "delighted", anchor: "We did it", effect: "confetti" }),
    ])));

    expect(parsed?.beats[0].effect).toBe("none");
    expect(parsed?.beats[1].effect).toBe("confetti");
  });

  it("rejects overly long or overly broad anchors", () => {
    const tooLong = performance([beat({ anchor: "a".repeat(CHARACTER_ANCHOR_MAX_LENGTH + 1) })]);
    const tooBroad = performance([beat({ anchor: "one two three four five six seven eight nine" })]);
    const punctuationOnly = performance([beat({ anchor: "..." })]);
    expect(parseCharacterPerformance(JSON.stringify(tooLong))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(tooBroad))).toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(punctuationOnly))).toBeNull();
  });

  it("rejects oversized arguments before parsing", () => {
    const oversized = JSON.stringify({ silent: false, beats: [beat({ anchor: "x".repeat(CHARACTER_ANCHOR_MAX_LENGTH) })] })
      .padEnd(MAX_CHARACTER_PERFORMANCE_ARGUMENT_CHARS + 1, " ");
    expect(parseCharacterPerformance(oversized)).toBeNull();
  });

  it("accepts a maximum of four ordered beats and rejects a fifth", () => {
    const beats = [
      beat({ anchor: "One" }),
      beat({ expression: "curious", anchor: "Two" }),
      beat({ expression: "amused", anchor: "Three" }),
      beat({ expression: "concerned", anchor: "Four" }),
    ];
    expect(parseCharacterPerformance(JSON.stringify(performance(beats)))).not.toBeNull();
    expect(parseCharacterPerformance(JSON.stringify(performance([...beats, beat({ expression: "relieved", anchor: "Five" })])))).toBeNull();
  });

  it("supports fenced JSON but never evaluates surrounding text", () => {
    const raw = `Here is the performance:\n\n\`\`\`json\n${JSON.stringify(performance())}\n\`\`\``;
    expect(parseCharacterPerformance(raw)).toBeNull();
    expect(parseCharacterPerformance(`\`\`\`json\n${JSON.stringify(performance())}\n\`\`\``)).not.toBeNull();
  });
});
