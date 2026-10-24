import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoiceClient, type VoiceGrounding, type VoiceGroundingRequest } from "./realtime";

type WireEvent = Record<string, unknown>;

type InternalClient = {
  channel: { readyState: string; send: (raw: string) => void; close: () => void };
  nativeCharacterEnabled: boolean;
};

function responseCreates(events: WireEvent[]): WireEvent[] {
  return events.filter((event) => event.type === "response.create");
}

function makeCallbacks(errors: string[]) {
  return {
    onPhase: () => undefined,
    onTranscriptReset: () => undefined,
    onTranscriptDelta: () => undefined,
    onUserTranscriptReset: () => undefined,
    onUserTranscriptDelta: () => undefined,
    onAmplitude: () => undefined,
    onError: (message: string) => errors.push(message),
  };
}

describe("Realtime SHERPA grounding", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createClient(
    grounding: (request: VoiceGroundingRequest) => Promise<VoiceGrounding | null>,
    events: WireEvent[],
    errors: string[],
    nativeCharacterEnabled = false,
  ): RealtimeVoiceClient {
    const voice = new RealtimeVoiceClient(makeCallbacks(errors), {
      grounding,
      reactions: false,
    });
    const client = voice as unknown as InternalClient;
    client.nativeCharacterEnabled = nativeCharacterEnabled;
    client.channel = {
      readyState: "open",
      send: (raw) => events.push(JSON.parse(raw) as WireEvent),
      close: () => undefined,
    };
    return voice;
  }

  it("puts verified document instructions into response.create without the character tool", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const grounding = vi.fn(async () => ({
      context: "Verified excerpt: leave requests must be sent by email.",
    }));
    const voice = createClient(grounding, events, errors);

    voice.sendTextTurn("How do I request leave?");
    await vi.waitFor(() => expect(responseCreates(events)).toHaveLength(1));

    const response = responseCreates(events)[0].response as Record<string, unknown>;
    expect(response.instructions).toContain("Verified excerpt: leave requests must be sent by email.");
    expect(response.instructions).toContain("<company_context>");
    expect(response.tool_choice).toBeUndefined();
    expect(grounding).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    voice.close(false);
  });

  it("keeps the shared character capability rules when native character mode is enabled", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const grounding = vi.fn(async () => ({ context: "Verified company context." }));
    const voice = createClient(grounding, events, errors, true);

    voice.sendTextTurn("What is in the document?");
    await vi.waitFor(() => expect(responseCreates(events)).toHaveLength(1));

    const response = responseCreates(events)[0].response as Record<string, unknown>;
    expect(response.instructions).toContain("# Embodied character");
    expect(response.instructions).toContain("perform_character tool");
    expect(response.instructions).toContain("<company_context>");
    expect(errors).toEqual([]);
    voice.close(false);
  });

  it("keeps the prior user question available for a grounded follow-up", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const requests: VoiceGroundingRequest[] = [];
    const grounding = vi.fn(async (request: VoiceGroundingRequest) => {
      requests.push(request);
      return { context: "Verified company context." };
    });
    const voice = createClient(grounding, events, errors);

    voice.sendTextTurn("What does the leave policy cover?");
    await vi.waitFor(() => expect(grounding).toHaveBeenCalledTimes(1));
    voice.sendTextTurn("Can you explain more?");
    await vi.waitFor(() => expect(grounding).toHaveBeenCalledTimes(2));

    expect(requests[1].previousQuestion).toContain("What does the leave policy cover?");
    expect(requests[1].previousQuestion?.length).toBeLessThanOrEqual(4_000);
    expect(errors).toEqual([]);
    voice.close(false);
  });

  it("fails closed when document grounding fails", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const grounding = vi.fn(async () => {
      throw new Error("document service unavailable");
    });
    const voice = createClient(grounding, events, errors);

    voice.sendTextTurn("What is the leave policy?");
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0]).toContain("could not verify the documents");
    expect(responseCreates(events)).toHaveLength(0);
    voice.close(false);
  });

  it("uses conversational instructions for hello without leaking supplied policy evidence", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const displayed: Array<VoiceGrounding | null> = [];
    const voice = new RealtimeVoiceClient({
      ...makeCallbacks(errors),
      onGrounding: (value) => displayed.push(value),
    }, {
      grounding: async () => ({
        mode: "conversation",
        context: "Stale employee policy must not survive.",
        sources: [{ id: "old-policy" }],
      }),
      reactions: false,
    });
    const internal = voice as unknown as InternalClient;
    internal.channel = { readyState: "open", send: raw => events.push(JSON.parse(raw)), close: () => undefined };
    voice.sendTextTurn("Hello!");
    await vi.waitFor(() => expect(responseCreates(events)).toHaveLength(1));
    const response = responseCreates(events)[0].response as Record<string, unknown>;
    expect(response.instructions).toContain("No company documents are needed");
    expect(response.instructions).not.toContain("Stale employee policy");
    expect(response.instructions).not.toContain("cannot confirm");
    expect(displayed.at(-1)).toEqual({ mode: "conversation", context: "", sources: [] });
    expect(errors).toEqual([]);
    voice.close(false);
  });

  it("does not treat missing document evidence as a greeting", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const voice = createClient(async () => ({ context: "", sources: [] }), events, errors);
    voice.sendTextTurn("What is my leave entitlement?");
    await vi.waitFor(() => expect(responseCreates(events)).toHaveLength(1));
    const response = responseCreates(events)[0].response as Record<string, unknown>;
    expect(response.instructions).toContain("No verified company-document evidence");
    expect(response.instructions).not.toContain("No company documents are needed");
    voice.close(false);
  });

  it("keeps separate spoken output items readable and recovers their final suffix", async () => {
    const events: WireEvent[] = [];
    const errors: string[] = [];
    const voice = createClient(async () => ({ context: "Carry your ID." }), events, errors);
    voice.sendTextTurn("What should I know?");
    await vi.waitFor(() => expect(responseCreates(events)).toHaveLength(1));
    const internal = voice as unknown as {
      handleMessage: (raw: string) => void;
      generatedTranscript: string;
    };
    const deliver = (event: WireEvent) => internal.handleMessage(JSON.stringify(event));
    deliver({ type: "response.created", response: { id: "reply-1" } });
    deliver({ type: "response.output_audio_transcript.delta", response_id: "reply-1", item_id: "intro", delta: "Checking." });
    deliver({ type: "response.output_audio_transcript.done", response_id: "reply-1", item_id: "intro", transcript: "Checking." });
    deliver({ type: "response.output_audio_transcript.delta", response_id: "reply-1", item_id: "answer", delta: "Carry your" });
    deliver({ type: "response.output_audio_transcript.done", response_id: "reply-1", item_id: "answer", transcript: "Carry your ID." });
    expect(internal.generatedTranscript).toBe("Checking. Carry your ID.");
    expect(errors).toEqual([]);
    voice.close(false);
  });
});
