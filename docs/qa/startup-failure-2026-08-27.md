# Startup failure follow-up

The screenshot's generic startup message came from a backend branch that hid
every non-401 provider failure. Its original response body was not retained, so
the exact cause cannot be recovered from that screenshot. The preceding live
run explicitly reported exhausted API credits.

Current in-app inspection found a separate microphone `Permission denied` error.
After the fix, one bounded Start attempt reproduced the actionable message:
"Microphone access is blocked. Allow the microphone for this site, then start
again." It failed before a provider session or conversational turn was requested.
No permission was changed and no new API voice reply was generated.

Changes:

- Safe, specific messages distinguish credits, project/organization limits,
  rate limits, credentials, model access, session configuration, and outages.
  Raw provider response bodies and credentials are never returned or logged.
- Specific billing codes take precedence over broad `insufficient_quota` types,
  following [OpenAI's error-code documentation](https://developers.openai.com/api/docs/guides/error-codes).
- Denied, missing, busy, and security-blocked microphones have actionable messages.
- The client preserves server error messages, rejects non-text error payloads,
  and still closes microphone/peer resources after failed setup.

Verification: 27 focused tests, full suite 362/362 across 34 files, TypeScript,
and production build passed. The normal preview shows the verified microphone
permission message. Live billing and conversational behavior were not retested.

Next: allow microphone access for the local preview and address the previously
observed API-credit failure before resuming live conversation acceptance checks.
