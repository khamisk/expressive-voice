import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHERPA_PARENT_ORIGIN,
  sherpaParentOrigins,
  sherpaRuntimeStatus,
} from "./sherpa-embed-config";

describe("SHERPA embed deployment configuration", () => {
  it("keeps the loopback parent default when hosted mode is off", () => {
    expect(sherpaParentOrigins({})).toEqual({
      hosted: false,
      parentOrigins: [DEFAULT_SHERPA_PARENT_ORIGIN],
    });
    expect(sherpaParentOrigins({
      SHERPA_VOICE_PARENT_ORIGINS: "https://suite.example.com",
    })).toEqual({
      hosted: false,
      parentOrigins: [DEFAULT_SHERPA_PARENT_ORIGIN],
    });
  });

  it("accepts only explicit HTTPS parents under the hosted opt-in", () => {
    expect(sherpaParentOrigins({
      SHERPA_VOICE_HOSTED: "1",
      SHERPA_VOICE_PARENT_ORIGINS: [
        "https://suite.example.com",
        "http://suite.example.com",
        "https://suite.example.com/private",
        "https://suite.example.com?tenant=one",
        "https://suite.example.com",
      ].join(","),
    })).toEqual({
      hosted: true,
      parentOrigins: ["https://suite.example.com"],
    });
  });

  it("keeps a loopback parent valid in hosted mode", () => {
    expect(sherpaParentOrigins({
      SHERPA_VOICE_HOSTED: "1",
      SHERPA_VOICE_PARENT_ORIGINS: "http://127.0.0.1:4103,https://suite.example.com",
    }).parentOrigins).toEqual([
      "http://127.0.0.1:4103",
      "https://suite.example.com",
    ]);
  });

  it("returns safe runtime metadata without the credential", () => {
    expect(sherpaRuntimeStatus("configured-provider-key", "gpt-realtime-2.1", true)).toEqual({
      ready: true,
      model: "gpt-realtime-2.1",
      usageTrackingEnabled: true,
    });
    expect(sherpaRuntimeStatus(undefined, "gpt-realtime-2.1", false)).toEqual({
      ready: false,
      model: "gpt-realtime-2.1",
      usageTrackingEnabled: false,
    });
  });

  it("requires the company usage observer before hosted readiness", () => {
    expect(sherpaRuntimeStatus("configured-provider-key", "gpt-realtime-2.1", false, true)).toEqual({
      ready: false,
      model: "gpt-realtime-2.1",
      usageTrackingEnabled: false,
    });
    expect(sherpaRuntimeStatus("configured-provider-key", "gpt-realtime-2.1", true, true).ready).toBe(true);
  });
});
