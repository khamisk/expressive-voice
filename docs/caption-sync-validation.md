# Caption and performance timing follow-up — 2026-08-27

## Reproduced causes

- `captionWindow` forcibly replaced the bubble after five words. A six-word
  question therefore put “side?” alone in the next fragment.
- Chained word-length timeouts re-gated on smoothed output amplitude. A quiet
  phoneme or pause could start another wait and accumulate delay.
- New words faded in over 180 ms after their release event. That was additional
  visible latency, independent of audio timing.
- A late `response.done` duration estimate did not reschedule the pending word.
- Server output-buffer completion flushed the remaining transcript before
  confirming that the local speaker tail had drained.
- Live free-text director probes produced prefixed, quoted, and malformed JSON.
  The early caption parser was less tolerant than the existing full-object cue
  extractor. Waiting for the entire plan also delayed its first usable cue.
  Numbering multiple cues inside one caption proved unreliable, too.

## Current contracts

- The voice prompt asks for short, line-broken thoughts. A separate, nonblocking
  director uses forced private function arguments: `captions` first and then
  `cues`. Caption lines must preserve every original word in order. They are
  formatting data, never extra spoken text or executable actions.
- Each closed, locally validated cue can be queued before the full plan ends.
  Its source-word anchor, not a model-supplied counter, determines order. Pending
  cues are only released at their playback position, once; stale beats are dropped.
- A short thought stays together. Articles, possessives, and prepositions cannot
  be stranded from what follows; a one-word tail is merged. Natural punctuation
  and lookahead work when model formatting is late or invalid.
- Caption plans only change future boundaries. Hidden captions keep advancing;
  toggling visibility cannot replay text, audio, or facial actions.
- `SpeechTimeline` uses absolute playback deadlines. Captions and word/phrase
  acting share those indices. Caption ink is visible on its release frame with
  only a small positional settle, not a fade from invisible text. Thought changes
  do not overlay two different sentences.
- Live timing is an estimate. The local `AudioContext` output timestamp is used
  when available; a monotonic local clock is the fallback. Output-token duration
  corrects future timing, not already-released words. A local drain check delays
  the finished state until the speaker tail is quiet, with a bounded fallback.
- Sustained quiet near a punctuation boundary can hold the following thought
  until audio resumes. A quiet phoneme does not add a new word delay. The clock
  has a bounded recovery if the expected resume never arrives.

## Real provider experiment

`scripts/audit-speech-timing.mjs` captured real `gpt-realtime-2.1` / Cedar output.
The complete run is `public/performance/timing-audit/final-2026-08-27/`.
These are generated test lines, not microphone input or a browser conversation.

| Sample | Buffer duration | Transcript/audio deltas | Measured speech envelope | Trailing silence |
| --- | ---: | ---: | --- | ---: |
| “What’s going on on your side?” | 2.65 s | 8 / 7 | about 20–2080 ms | about 570 ms |
| Correction, thanks, reassurance | 6.50 s | 23 / 17 | 360–1220, 2080–2700, 3900–4880, 5060–6060 ms | about 440 ms |

Both transcripts match the requested words. Transcript deltas arrived before the
first audio delta, and the last transcript delta arrived before the final audio
chunk. Thus generation arrival times are not speaker/word timestamps. The second
sample preserved two newlines; newline characters alone do not encode pause duration.

The envelope uses 20 ms PCM windows with an on threshold of .005, off threshold
.0035, and two quiet windows of hysteresis. Boundaries above exclude the quiet
release windows. Whisper word timestamps are included as an independent
**approximate** reference, not ground-truth word timing from Realtime. The WAVs
contain real pauses and tail silence; uniformly distributing words across their
whole duration is insufficient.

### Offline clock comparison

`npx tsx scripts/compare-speech-timing.ts` reads those existing WAVs and makes no
provider calls or writes. It approximates the app's smoothed meter in 16 ms PCM
windows and compares the same clock with and without phrase-pause observations.
Both the complete transcript and total duration are supplied at time zero; this
is **idealized replay, not a live-browser end-to-end benchmark**. Source words are
checked against the approximate Whisper labels before calculating any score.

| Recording | Without pause observations: mean / maximum absolute start error | With observations |
| --- | ---: | ---: |
| Side question | 120 / 240 ms | 120 / 240 ms |
| Empathy/correction | 155 / 400 ms | 129 / 368 ms |
| All 24 words | 146 / 400 ms | 127 / 368 ms |

No pause was invented in the short question. In the longer clip, “Thanks” was
released at 2080 ms and the later “That” at 3904 ms on the absolute WAV timeline,
matching observed phrase resumptions. These figures do **not** establish exact
word sync. In particular, Whisper labels the first “I” at zero despite the PCM
having about 360 ms of leading silence; its labels are not ground truth.

### Live structured-director checks

`npx tsx scripts/audit-caption-director.mjs` makes three bounded, synthetic,
text-only provider requests (at most 800 output tokens each). It uses the app's
low-reasoning setting, exact prompt, function schema, and local parsers. The
`--reactions` option instead tests a win and its reversal with the actual
224-token reaction cap. These commands are not part of the offline test suite.

The final configured run passed all five cases:

| Case | Valid captions available | First validated cue | Complete response |
| --- | ---: | ---: | ---: |
| “What's going on on your side?” | 1816 ms; one caption | 2192 ms | 2901 ms |
| Empathy followed by a question | 831 ms; three thoughts | 1259 ms | 2066 ms |
| Correction, thanks, reassurance | 620 ms; three thoughts | 1074 ms | 2326 ms |
| Earned win | Not applicable | Final reaction | 715 ms |
| Win corrected into a rejection | Not applicable | Final reaction | 738 ms |

The empathy cues were concerned → sad → curious. The win produced joyful with
confetti; its reversal produced sad with no effect. These are observed provider
outputs, not hard-coded responses. Elapsed values start when the request is sent
over an open socket; they exclude connection setup and are not playback times.
Earlier free-text probes failed formatting validation, including on the correct
low-reasoning configuration. They are not represented as successful cases or as
a controlled latency comparison with the function-call path.

## Verification boundary

Pure tests cover phrase grouping, model-plan validation, no word leakage, stable
streamed boundaries, monotonic timing, late duration correction, cancellation,
local drain handling, and shared caption/acting indices. They do not establish
subjective naturalness or physical speaker/microphone performance.

Current automated result: **186 tests in 21 files passed**, **TypeScript checking
passed**, and the **production build passed**.

The approved Codex browser previously security-blocked the local preview. Its
current tab listing still reports the local page as unreachable. No alternate
browser, proxy, host, or debugging channel was used to bypass the block. Current
rendered motion, responsive wrapping, and physical microphone acceptance remain
unverified. Inspect 390×844, 360×800, and desktop once approved access is restored.

## API evidence

The [Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)
distinguishes generation, playback, and truncation and explicitly notes the lack
of precise text/audio alignment for truncation. The
[server-event reference](https://platform.openai.com/docs/api-reference/realtime-server-events)
does not expose assistant word-playback timestamps. The
[cost guide](https://developers.openai.com/api/docs/guides/realtime-costs) documents
approximately 50 ms per output audio token, which is a duration estimate only.

The [Realtime client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events)
supports per-response functions and forced function choice on out-of-band
responses. The [Realtime server-event reference](https://developers.openai.com/api/reference/resources/realtime/server-events)
documents streamed function arguments. The
[official Node SDK note](https://github.com/openai/openai-node/blob/main/docs/tools.md#realtime-function-tools)
states that Realtime function definitions do not accept `strict`; this app does
not send that flag or claim schema enforcement replaces local validation.

Exact word locking would require a separate alignment/controlled-playback
pipeline. That would need a measured latency tradeoff; this pass does not silently
replace the low-latency, full-duplex voice connection with a buffered TTS pipeline.
