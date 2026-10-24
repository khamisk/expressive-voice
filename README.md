# Mood Voice

A deliberately tiny expressive voice interface built around OpenAI Realtime: one animated character, one conversation button, optional mood labels, and short replacing spoken captions.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Put a fresh OpenAI project key in `OPENAI_API_KEY`.
3. Run `npm install`.
4. Run `npm run dev` and open `http://127.0.0.1:5173`.

The permanent API key stays in the local Express server. It is never sent to the browser. Use HTTPS when deploying because browsers only allow microphone access in secure contexts (localhost is permitted for development).

## Hosted SHERPA connector

`Dockerfile.sherpa` packages the existing renderer and a loopback-only sidecar
API on port `8791`. A private HTTPS origin may serve `/sherpa.html`,
`/sherpa-config.js`, and the generated `dist-sherpa` assets through the
approved public renderer path. Set `SHERPA_VOICE_HOSTED=1` and provide an
explicit comma-separated `SHERPA_VOICE_PARENT_ORIGINS` allowlist; remote HTTP
origins are rejected and the session API still requires a loopback request and
`SHERPA_VOICE_BRIDGE_TOKEN`. The provider model override is
`OPENAI_REALTIME_MODEL` (there is no `SHERPA_VOICE_MODEL` setting in this
runtime).

The hosted sidecar's `ready` status requires both `OPENAI_API_KEY` and the
company-owned usage observer. An approved private build or runtime mount must
provide the observer at `file:///app/company-hooks/voice-monitor.mjs` together
with its local import graph (`voice-pricing.mjs`, `index.mjs`, `pricing.mjs`,
`pricing.json`, `transport.mjs`, and `schema.sql`). The observer uses the
installed `ws` dependency. If the hook is absent or fails to load,
`/api/config` and `/healthz` report `ready: false`; no recorded-cost coverage
is implied.

## Current voice setup

- Model: `gpt-realtime-2.1`
- Voice: `cedar`
- Transport: WebRTC
- Turn detection: calibrated client-owned detection with phrase-boundary talk-over handoffs
- Performance: native voice-selected facial beats, rendered-state feedback, and local fallback acting

The server and language audits share `server/voice-persona.ts`. Its default is a
direct, brief conversational reply, not an automatic interview or advice offer.
The prompt targets one 5–18-word ordinary thought and 2–8-word acknowledgements;
these are pacing targets, not hard truncation limits. Explicit requests for detail
can receive longer answers. Provider checks still occasionally produce an unwanted
offer after bad news; see `docs/persona-text-audit.md`.
End and start a new conversation after changing this prompt; already-connected
Realtime sessions retain their original instructions.

The visible transcript is not the conversation store. OpenAI's Realtime session keeps the conversation context for the life of the connection even though prior turns are not rendered in the UI.

## Avatar renderer

The procedural geometry uses `@bible-strong/avatar-core`, licensed under AGPL-3.0-only. If you host or redistribute the app, preserve the required source and license obligations.

A persistent spring controller carries eye shape, head pose, body position, squash/stretch, and velocity between spoken beats. Nineteen semantic feelings each have eight named local variants (152 entries), composed with seven authored gestures and eighteen finite eye accents. Twelve compact intentions guide selection; recent-use history keeps successive turns from restarting the same sequence. Word ticks add articulation without changing the emotion or erasing a director-selected eye accent. Whole-pose holds let the eyes and head land before the next variant. This is a composable vocabulary, not a claim that 152 combinations were individually judged as distinct emotions. Authored idle glances are separate from speech: neither uses an independent camera orbit.

The voice knows it represents the character and can use the optional `perform_character` function to select up to four meaningful facial/gesture beats per reply. It receives the latest renderer state before replying; scheduling a beat is not treated as proof it appeared. Immediate recognition and later exact-word anchors use the same continuous actor. Explicit nonverbal requests can act without speech. Function arguments are private UI data, never captions or executable actions, and are locally validated. A tool-only plan requires one audio continuation, so native control adds a generation round trip in that case. Plain audio-only replies retain local acting. The legacy out-of-band director remains available for non-native sessions but is not called by the default native path.

Recognition can begin before the assistant's audio and carry through voice
startup. During overlap, a prepared new reaction waits for the old spoken turn to
hand off. Confetti, sparkles, warm hearts, a puzzled question, and an insight bulb
are finite, meaning-gated accents attached to the character, not ambient loops.

Captions follow complete short thoughts rather than a five-word cutoff. Native mode uses the voice transcript's sentence/newline boundaries and linguistic lookahead. Legacy director-authored lines are locally validated; invalid rewrites and unsafe splits such as “your / side” are rejected or merged. Already-visible boundaries are frozen, and the complete conversation remains separate from the displayed fragment.

One absolute local-playback timeline releases both words and acting ticks. The first local audio starts it; quiet phonemes no longer add another word timer. A small visual lead and immediately visible text remove the old typewriter fade delay. Expressions can prepare just ahead of their matching words. Reported audio duration is only an estimate, not a word alignment signal. Live timing remains **approximate, not word-perfect**: the WebRTC API does not provide word-level output timestamps. Hiding captions never restarts the cursor or performance. See `docs/caption-sync-validation.md` for measured provider evidence and remaining acceptance work.

Brief acknowledgements such as “yeah” do not cancel the voice or create a second reply. Substantive overlap waits for a phrase boundary or a measured audio pause, then fades before cancel/clear. Explicit stop requests take priority; finite safety deadlines prevent the assistant from talking over sustained input indefinitely. This is an implementation using public API controls, not a reproduction of ChatGPT's private client.

The developer gallery at `/?gallery=expressions&motion=full` shows all 152 variants, with a feeling filter and individual replay. Thumbnails are static held frames from the production actor; only the selected preview animates. It is silent and never starts a microphone or voice request. `/?studio=performance&motion=full` plays explicitly labeled, real Cedar recordings through the same renderer. The longer study has four phrase beats aligned to its recorded word timestamps; those authored study cues never supply live replies.

Browser reduced-motion settings lower gesture travel, remove automatic blinking, and replace particle travel with a stationary accent. Expression changes still blend without snapping. `?motion=full` explicitly opts into the full performance.

## Performance verification

- Live output metering and facial updates use display frames with a 32 ms watchdog for embedded-browser RAF throttling.
- Tests cover silent output, microphone/output separation, phrase changes, rapid reversal, head/body limits, smile curves, reduced motion, effect lifetime, and contextual-request isolation.
- The primary button and display switches retain their existing state/keyboard contracts. Toggling transcript or mood visibility does not restart the character.
- `npm test`, `npm run typecheck`, and `npm run build` verify the implementation. The rendered and live-provider checks, including known limits, are tracked in `docs/character-validation.md`.
- Development-only `?syntheticAudio=1` exposes a clearly labeled typed-input test form. It sends real turns through the real voice service without opening a microphone. It is not a fake response mode.
- Development-only `?voiceQA=1` offers six labeled synthetic spoken inputs through the real WebRTC input track. It never plays those inputs through the local speakers. Start, send good news, then try a brief acknowledgement or correction while the AI talks. It does not validate physical microphone hardware or echo cancellation.
- The latest native-character pass used the approved in-app browser and real provider replies, including recorded talk-over inputs. It passed 441 tests plus typecheck/build. Physical microphone acoustics and exact word sync remain unverified; see [the native character QA record](docs/qa/native-character-2026-08-27.md).
- The conversational/reaction follow-up, real director probes, and language-audit limits are recorded in `docs/conversation-reaction-validation.md`.
- The variation/short-turn follow-up and offline recorded-audio handoff check are in `docs/meaning-variation-validation.md`. Replay the latter without new API usage using `node --import tsx scripts/audit-recorded-handoff.mjs`.
