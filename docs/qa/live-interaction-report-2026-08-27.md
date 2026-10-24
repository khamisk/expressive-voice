# Live interaction QA — 2026-08-27

## Verdict

The interaction is not fully solved. The browser tests reproduced an abrupt overlap cutoff and a stuck speaking state that the automated tests do not catch. Replies are shorter, but late speech cues and occasional incorrect emotion choices still weaken the performance.

## What was tested

- 11 context-preserving phrases through the actual browser, Realtime voice output, caption renderer, and expression director.
- Four valid recorded-input overlap trials: brief “yeah” twice, a correction, and an unrelated new topic.
- A completed-caption hide/show check.
- 276 automated tests across 28 files, plus the TypeScript/production build: passed.

The phrase inputs were typed synthetic prompts; the overlap inputs were existing synthetic speech recordings sent into the real WebRTC input track. No physical microphone was used. Audio levels, provider lifecycle events, rendered captions, and avatar state were inspected; this is not a human listening assessment or proof of exact word-level synchronization.

## Phrase results

| Input | Reply length | Observed behavior |
| --- | ---: | --- |
| “I finally got the job…” | 14 words | Joyful, confetti. Appropriate recognition; no assistant speech-plan cue appeared. |
| “Actually… it was a rejection.” | 13 | Sad/concerned; no celebratory effect. |
| Switch to eggs and rice | 26 | Answers the new topic. “Like scallions” oddly promotes the face to delighted. |
| “Next Thursday, not tomorrow.” | 5 | “Ah, next Thursday. Got it.” Short and grounded. |
| Code/break/issue joke | 16 | Amused and a sparkle. |
| Sarcastic “Fantastic… laptop crashed…” | 15 | Frustrated/concerned, without confetti. |
| “Just making coffee before work.” | 19 | Adds unnecessary flourishes; “I hope” triggers an overly concerned face. |
| Apartment win + leaving friends | 20 | Acknowledges mixed feelings, but several emotionally meaningful speech beats stay neutral. |
| “Thanks for keeping it simple.” | 7 | Compact acknowledgement. |
| First paying customer | 14 | Excited/delighted/proud with a sparkle, different from the first win’s confetti. |
| “What’s going on on your side?” | 6 | Exact requested text, one caption window; “side” was not orphaned. |

These are individual outputs, not statistical guarantees. The 11 replies ranged from 5 to 26 words. The coffee reply still feels padded despite its modest word count.

## Confirmed failures

### 1. Backchannel audio is cleared before our handoff runs

In the correlated “yeah” trial:

- First measurable output: 6,015 ms after starting the 4.898-second input recording.
- “Yeah” injected at 6,561 ms; last sampled audible output at 6,951 ms.
- The current voice response emitted `output_audio_buffer.cleared` immediately after `speech_started`.
- No outbound cancel or clear preceded it. The echoed configuration explicitly had `interrupt_response: false`.
- The UI remained `speaking` through the 18-second test limit, with no audio, while captions advanced to “Nicely done.”

An earlier keepalive-enabled trial reproduced the same symptom through a 25-second limit. This establishes the event sequence, not the provider’s internal reason for clearing.

The app ignores a current-response clear unless `outputClearPending` is true (`src/lib/realtime.ts:1670–1674`). Its silence fallback is disabled once real buffer events have been seen (`:1953`). Together those conditions explain the stuck local state.

A substantive correction eventually received a second reply and a natural buffer stop, but the initial reply had already been abruptly cleared. The correction’s middle caption was not sampled: capture briefly stopped at the intermediate listening state, then a later completion check recovered the full lifecycle.

The unrelated-topic trial answered the fox/tiny-door story rather than continuing the job topic: “That’s wonderfully eerie. The curious fox, the tiny door, and then that laugh? Yeah, that’s a cue to leave.” However, the old response was cleared and restarted before finishing. Topic understanding worked; smooth handoff did not.

### 2. Speech-specific facial cues arrive late

For the nine phrase cases with an assistant speech cue, the first such cue appeared roughly **1.16–2.63 seconds after the first audible output sample**. The initial job win and date correction had no assistant speech-plan cue in the sampled turn.

The face can react earlier using user-recognition or fallback state, so it is not blank throughout this delay. But that is different from acting the words currently being spoken. Diagnostics include rejected plans whose phrase was already presented.

### 3. Meaning and variety still need work

Neutral coffee receives concern; a scallion suggestion receives delight. Mixed feelings can remain neutral across meaningful beats. There are many named variants, but some holds repeat for roughly 1–2.6 seconds. More variants alone will not fix late or inappropriate selection.

Eyes were generally large; the smallest sampled heights were isolated blink frames. Irregular DOM sampling cannot prove or rule out a one-frame teleport.

### 4. Caption ownership is not always clean

At the start of the coffee turn, the previous reply’s “when it keeps happening.” remains visible in the thinking phase. Its old word tick also persists. That contaminates a naive first-caption timing measurement.

Showing a completed transcript did **not** replay it: the caption and word tick stayed unchanged across all eight post-toggle samples. The “on your side” boundary also passed this run. Neither result establishes precise audio/word alignment.

## Changes made during this testing pass

- Fixed the developer-only recorded-input helper to keep sending zero-valued audio between clips. Previously RTP stopped with the recording, so the remote turn detector never received trailing silence. Three initial attempts exposed that helper issue and are not counted as valid conversational trials.
- Added 22 phrase/turn-taking tests and three helper lifecycle tests.
- Removed all temporary transport instrumentation after preserving its observations.
- Left production response, expression, caption, and handoff behavior unchanged.
- Ended test calls and restored the normal preview in its idle state.

## Next work, in priority order

1. Handle matching unsolicited buffer clears without hanging, and solve the actual audio cutoff before tuning handoff timing.
2. Make speech cues available early enough for their words; reset stale caption ownership on new turns.
3. Tighten emotional confidence and vary performances within the correct emotion, then repeat the same real-input cases.
4. Validate final timing with a physical microphone and a listening review; do not equate green unit tests with natural conversation.

## Evidence

- `docs/qa/live-phrases-2026-08-27.json`: 11 phrase cases / 617 rendered samples.
- `docs/qa/live-audio-overlap-2026-08-27.json`: initial feeder diagnostics, four valid overlap trials, correlated lifecycle events, and the caption-toggle check.
- The live phrase session echoed the shared persona hash `581725cad79c28de`.

