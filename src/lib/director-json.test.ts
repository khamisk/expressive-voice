import { describe, expect, it } from "vitest";
import { completeJsonObject, completeJsonObjectArray } from "./director-json";

describe("streaming director JSON extraction", () => {
  it("extracts the first complete object after arbitrary provider prefix text", () => {
    const payload = {
      expression: "curious",
      note: 'a } brace, a ] bracket, and an escaped "quote"',
      nested: { ok: true },
    };
    const object = JSON.stringify(payload);

    expect(completeJsonObject(`(= > ${object} trailing provider text`)).toBe(object);
    expect(JSON.parse(completeJsonObject(`prefix ${object}`) ?? "null")).toEqual(payload);
  });

  it("waits for a complete object instead of returning a partial response", () => {
    expect(completeJsonObject("model: {\"expression\":\"curious\"")).toBeNull();
    expect(completeJsonObject("model: {\"nested\":{\"message\":\"brace }\"")).toBeNull();
  });

  it("finds a top-level cues array even when captions and nested cues appear first", () => {
    const raw = [
      "provider > {",
      '"captions":["First thought.","Second thought."],',
      '"metadata":{"cues":[{"id":"nested"}]},',
      '"cues":[{"id":"first"},{"id":"second"}]}',
    ].join("");

    expect(completeJsonObjectArray(raw, "cues")).toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    expect(completeJsonObjectArray(raw, "missing")).toBeNull();
    expect(completeJsonObjectArray('{} {"cues":[{"id":"later-object"}]}', "cues")).toBeNull();
  });

  it("returns complete cue objects before an incomplete first or second entry", () => {
    expect(completeJsonObjectArray('stream {"cues":[{"id":"first"', "cues")).toEqual([]);
    expect(completeJsonObjectArray('stream {"cues":[{"id":"first"},{"id":"second"', "cues")).toEqual([
      { id: "first" },
    ]);
  });

  it("preserves object order and ignores braces, brackets, and escaped quotes in strings", () => {
    const first = { id: "first", text: 'literal } ] { [ and \\"quotes\\"' };
    const second = { id: "second", nested: { values: ["]", "}", "\\"] } };
    const partial = '{"id":"third","text":"unfinished';
    const raw = `prefix {"cues":[${JSON.stringify(first)},${JSON.stringify(second)},${partial}`;

    expect(completeJsonObjectArray(raw, "cues")).toEqual([first, second]);
  });

  it("rejects a completed non-object element instead of skipping it", () => {
    expect(completeJsonObjectArray('{"cues":[{"id":"first"},"bad",{"id":"second"}]}', "cues"))
      .toBeNull();
    expect(completeJsonObjectArray('{"cues":[{"id":"first"},null]}', "cues")).toBeNull();
  });

  it("rejects malformed closed objects and malformed separators", () => {
    expect(completeJsonObjectArray('{"cues":[{"id":}]}', "cues")).toBeNull();
    expect(completeJsonObjectArray('{"cues":[{"id":"first"} {"id":"second"}]}', "cues"))
      .toBeNull();
    expect(completeJsonObjectArray('{"cues":[{"id":"first"},]}', "cues")).toBeNull();
  });

  it("never evaluates JavaScript-looking strings while parsing", () => {
    const marker = "__directorJsonExecuted";
    const scope = globalThis as Record<string, unknown>;
    delete scope[marker];

    const raw = `{"cues":[{"code":"globalThis.${marker}=true"}]}`;
    expect(completeJsonObjectArray(raw, "cues")).toEqual([{ code: `globalThis.${marker}=true` }]);
    expect(scope[marker]).toBeUndefined();
  });
});
