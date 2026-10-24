export type SherpaEmbedEnvironment = Record<string, string | undefined>;

export type SherpaEmbedRuntimeConfig = {
  hosted: boolean;
  parentOrigins: string[];
};

export type SherpaEmbedRuntimeStatus = {
  ready: boolean;
  model: string;
  usageTrackingEnabled: boolean;
};

export const DEFAULT_SHERPA_PARENT_ORIGIN = "http://127.0.0.1:4103";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isExactOrigin(url: URL, candidate: string): boolean {
  return (
    url.origin === candidate
    && !url.pathname.replace(/\/$/u, "")
    && !url.search
    && !url.hash
  );
}

function configuredOrigin(candidate: string, hosted: boolean): string | null {
  const value = candidate.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!isExactOrigin(url, value)) return null;

    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) {
      return url.origin;
    }

    // A hosted renderer may be embedded by an explicitly configured HTTPS
    // suite origin. Never broaden this to arbitrary HTTP or to an unconfigured
    // HTTPS origin; the opt-in is intentionally server-side.
    if (hosted && url.protocol === "https:") return url.origin;
  } catch {
    // Ignore malformed origins. Falling back to the loopback default keeps a
    // bad deployment value from widening the frame-ancestors policy.
  }

  return null;
}

export function sherpaVoiceHosted(env: SherpaEmbedEnvironment = process.env): boolean {
  return env.SHERPA_VOICE_HOSTED === "1";
}

export function sherpaParentOrigins(
  env: SherpaEmbedEnvironment = process.env,
): SherpaEmbedRuntimeConfig {
  const hosted = sherpaVoiceHosted(env);
  const configured = (env.SHERPA_VOICE_PARENT_ORIGINS ?? "")
    .split(",")
    .map((candidate) => configuredOrigin(candidate, hosted))
    .filter((origin): origin is string => origin !== null);

  return {
    hosted,
    parentOrigins: configured.length > 0 ? [...new Set(configured)] : [DEFAULT_SHERPA_PARENT_ORIGIN],
  };
}

export function sherpaRuntimeStatus(
  apiKey: string | undefined,
  model: string,
  usageTrackingEnabled: boolean,
  requireUsageTracking = false,
): SherpaEmbedRuntimeStatus {
  return {
    // Only expose whether a credential is present. The credential itself must
    // never enter config, health, logs, or the browser.
    // Hosted SHERPA is only ready when its company-owned usage observer is
    // actually loaded. Local standalone Mood Voice remains usable without it.
    ready: Boolean(apiKey) && (!requireUsageTracking || usageTrackingEnabled),
    model,
    usageTrackingEnabled,
  };
}
