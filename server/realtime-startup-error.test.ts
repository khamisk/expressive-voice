import { describe, expect, it } from "vitest";
import { describeRealtimeStartupError } from "./realtime-startup-error";

describe("describeRealtimeStartupError", () => {
  it("maps insufficient quota to a readable non-retryable billing message", () => {
    const result = describeRealtimeStartupError(429, JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: "You exceeded your current quota. Please check your plan and billing details.",
      },
    }));

    expect(result.code).toBe("insufficient_quota");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/credit|quota|billing|plan/iu);
  });

  it("keeps a monthly quota limit distinct from a transient rate limit", () => {
    const result = describeRealtimeStartupError(429, JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: "The monthly usage limit has been reached.",
      },
    }));

    expect(result.code).toBe("insufficient_quota");
    expect(result.retryable).toBe(false);
    expect(result.error).not.toMatch(/rate limit|try again later/iu);
    expect(result.error).toMatch(/credit|quota|billing|limit/iu);
  });

  it("maps an explicit request rate limit to a retryable non-billing message", () => {
    const result = describeRealtimeStartupError(429, JSON.stringify({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests. Please retry after a short delay.",
      },
    }));

    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/rate|retry|moment/iu);
    expect(result.error).not.toMatch(/credit|billing|exhausted/iu);
  });

  it("treats an ambiguous 429 as rate limited without claiming credits are exhausted", () => {
    const result = describeRealtimeStartupError(429, JSON.stringify({
      error: { message: "Too many requests" },
    }));

    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/usage|capacity|billing|later|retry/iu);
    expect(result.error).not.toMatch(/no credits|insufficient credits|credits exhausted/iu);
  });

  it("reports an invalid API key without exposing provider wording", () => {
    const result = describeRealtimeStartupError(401, JSON.stringify({
      error: { code: "invalid_api_key", message: "The API key is invalid." },
    }));

    expect(result.code).toBe("invalid_api_key");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/key|credential/iu);
  });

  it("reports a missing model as a non-retryable model configuration error", () => {
    const result = describeRealtimeStartupError(404, JSON.stringify({
      error: { code: "model_not_found", message: "The requested model does not exist." },
    }));

    expect(result.code).toBe("model_unavailable");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/model/iu);
  });

  it("reports an invalid session request as non-retryable configuration", () => {
    const result = describeRealtimeStartupError(400, JSON.stringify({
      error: { code: "invalid_session", message: "The session configuration is invalid." },
    }));

    expect(result.code).toBe("session_configuration");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/session|configuration/iu);
  });

  it("treats a provider outage, including an HTML proxy response, as retryable", () => {
    const result = describeRealtimeStartupError(503, "<html><body>Service Unavailable</body></html>");

    expect(result.code).toBe("service_unavailable");
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/unavailable|try again|temporarily/iu);
    expect(result.error).not.toContain("<html>");
  });

  it("uses a safe non-retryable fallback for an unknown status", () => {
    const result = describeRealtimeStartupError(418, "I am a teapot");

    expect(result.code).toBe("session_failed");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/start|session|voice/iu);
  });

  it.each([
    ["credit_balance_exhausted", true],
    ["organization_spend_limit_exceeded", false],
    ["project_spend_limit_exceeded", false],
    ["organization_usage_limit_exceeded", false],
  ] as const)("classifies the documented %s provider code from a generic message", (providerCode, mentionsCredits) => {
    const result = describeRealtimeStartupError(429, JSON.stringify({
      error: { code: providerCode, message: "Request failed." },
    }));

    expect(result.code).toBe(providerCode);
    expect(result.retryable).toBe(false);
    if (mentionsCredits) {
      expect(result.error).toMatch(/credit/iu);
    } else {
      expect(result.error).toMatch(/organization|project|usage|limit/iu);
      expect(result.error).not.toMatch(/no credits|credits (?:have )?(?:run out|exhausted|depleted)/iu);
    }
  });

  it("never returns provider secrets or arbitrary provider messages", () => {
    const body = JSON.stringify({
      error: {
        code: "internal_error",
        message: "Bearer sk-proj-TEST_SECRET_VALUE should never be shown to the user.",
      },
    });

    const result = describeRealtimeStartupError(500, body);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("sk-proj-TEST_SECRET_VALUE");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("TEST_SECRET_VALUE");
    expect(result.error).not.toContain("should never be shown");
  });
});
