import { describe, expect, it } from "vitest";
import {
  BASELINE_VOICE_PERSONA_INSTRUCTIONS,
  CHARACTER_CAPABILITY_INSTRUCTIONS,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_VOICE_SPEED,
  PREVIOUS_VOICE_PERSONA_INSTRUCTIONS,
  DEFAULT_TRANSCRIPTION_MODEL,
  VOICE_PERSONA_INSTRUCTIONS,
  buildRealtimeSessionConfig,
} from "./voice-persona";
import { CHARACTER_TOOL, CHARACTER_TOOL_NAME } from "../src/lib/embodied-character";

describe("voice persona", () => {
  it("keeps the old prompt available as a controlled baseline", () => {
    expect(BASELINE_VOICE_PERSONA_INSTRUCTIONS).toContain("about 3 to 12 words each");
    expect(BASELINE_VOICE_PERSONA_INSTRUCTIONS).not.toBe(VOICE_PERSONA_INSTRUCTIONS);
  });

  it("keeps the pre-rewrite persona for side-by-side audits", () => {
    expect(PREVIOUS_VOICE_PERSONA_INSTRUCTIONS).toContain("Most ordinary replies are one spoken thought and one sentence");
    expect(PREVIOUS_VOICE_PERSONA_INSTRUCTIONS).not.toBe(VOICE_PERSONA_INSTRUCTIONS);
  });

  it("makes short replies the default and padding explicitly off-limits", () => {
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("# Length: this matters most");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Default: ONE short sentence, about 3 to 12 words. Then stop.");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("A second sentence is the exception, not the habit");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Facts, recommendations and quick answers: one sentence, under 15 words");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("No well-wishes");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("At most one question");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("A reaction alone is a complete reply");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("about 50 words at most");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Do not produce a spoken preamble or commentary message");
  });

  it("directs a lively spoken delivery and natural turn-taking", () => {
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("# Personality and tone");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("# Pacing and delivery");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Let your pitch move with the feeling");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Don't sound sing-song");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("A topic change: follow it immediately");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("\"Yeah\" or \"mhm\" isn't a new request");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("never reuse their wording");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("You are an AI, not a person with a real physical body");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("never em dashes or en dashes");
  });

  it("gives the voice a truthful, optional face capability", () => {
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("small white on-screen character");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("perform_character tool");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("at most once per assistant reply");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("not once per session");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("meaningful change of intent");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("even when the user does not literally ask for a face");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Plain acknowledgements and facts usually need no call");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("current-frame truth");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("AI, not a person with a real physical body");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Set silent false by default");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("asking to see a face does not mean");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("first beat with an empty anchor acts immediately");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("exactly one immediate beat with an empty anchor");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("voice tone and face on the same intent");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Show me your surprised face");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Without saying anything, give me a skeptical look");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("I finally got the job");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Actually, it was a rejection");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("delighted lift with a small spark");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("concerned comfort tilt with no effect");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("silent true");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("only schedules a performance; it is not proof that the frame has rendered");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("supplied App context as the current-frame truth");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("expressive authored head gestures with meaning");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("For a clearly playful, ironic, or amused reply");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("intent joke, and a small laugh effect");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("friendly golden greeting mark (the legacy heart effect key)");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("not a literal heart or a romantic signal");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).not.toContain("affectionate warmth");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Concern and sadness get a gentle head gesture with no decorative effect");
    expect(CHARACTER_CAPABILITY_INSTRUCTIONS).toContain("Do not invent an extra sentence just to carry an effect");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain(CHARACTER_CAPABILITY_INSTRUCTIONS);
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("Do not volunteer tool, pose, expression, or effect labels");
    expect(VOICE_PERSONA_INSTRUCTIONS).toContain("if the user directly asks what is on screen");
  });

  it("builds the production session with the low-latency audio policy", () => {
    const config = buildRealtimeSessionConfig();
    const audio = config.audio as {
      input: {
        turn_detection: null;
        noise_reduction: Record<string, unknown>;
        transcription: Record<string, unknown>;
      };
      output: Record<string, unknown>;
    };

    expect(config).toMatchObject({
      type: "realtime",
      model: DEFAULT_REALTIME_MODEL,
      instructions: VOICE_PERSONA_INSTRUCTIONS,
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      max_output_tokens: 1024,
      tools: [CHARACTER_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect((config.tools as Array<Record<string, unknown>>)[0].name).toBe(CHARACTER_TOOL_NAME);
    expect(audio.input.turn_detection).toBeNull();
    expect(audio.input.noise_reduction).toEqual({ type: "near_field" });
    expect(audio.input.transcription).toEqual({ model: DEFAULT_TRANSCRIPTION_MODEL });
    expect(audio.output).toEqual({ voice: DEFAULT_REALTIME_VOICE, speed: DEFAULT_VOICE_SPEED });
  });

  it("allows the audit to swap only the persona while preserving session behavior", () => {
    const config = buildRealtimeSessionConfig({
      model: "test-realtime",
      voice: "test-voice",
      transcriptionModel: "test-transcriber",
      instructions: BASELINE_VOICE_PERSONA_INSTRUCTIONS,
    });
    const audio = config.audio as {
      input: { transcription: Record<string, unknown> };
      output: Record<string, unknown>;
    };

    expect(config.model).toBe("test-realtime");
    expect(config.instructions).toBe(BASELINE_VOICE_PERSONA_INSTRUCTIONS);
    expect(audio.input.transcription).toEqual({ model: "test-transcriber" });
    expect(audio.output).toEqual({ voice: "test-voice", speed: DEFAULT_VOICE_SPEED });
    expect(config.reasoning).toEqual({ effort: "low" });
    expect(config.max_output_tokens).toBe(1024);
    expect(config).not.toHaveProperty("parallel_tool_calls");
  });
});
