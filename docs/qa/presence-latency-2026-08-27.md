# Response timing and character presence: 2026-08-27

## What was actually wrong

- Word ticks repeatedly restarted the base-face transition and the head gesture. A separate 680 ms variant reselection made a line cycle through unrelated deliveries. The recorded surprise phrase showed four base variants before its meaning changed.
- Every intent was effectively eligible for every family variant. Comfort could pick a lifted/punctuating delivery, and some empathy variations canceled the defining inward eye tilt.
- A late ASR interpretation could change the mood label but reuse the old cue ID. The physical performance remained latched to the earlier face.
- The live local turn detector waited 580 ms of trailing silence before committing a normal utterance. This is one source of latency, not the whole provider/playback delay.

## Changes

- A phrase owns its face and head gesture. Word ticks articulate the eyes without restarting that performance. A real phrase boundary can select another same-meaning variant; explicit authored variants stay pinned.
- Removed timer-driven base-face reselection and arbitrary word-driven glances/eye rolls. Those larger actions remain available for deliberate semantic and idle beats.
- Intent-specific variant pools preserve the full 152-entry authored bank. Empathy keeps its inward silhouette, including a continuous intensity-zero blend. Strong head gestures remain enabled.
- Removed an extra entry interpolation ahead of the physical spring. The target arrives sooner while visible pose and velocity remain continuous. Speech accents have a short independent envelope.
- The live detector now uses a 420 ms release, reducing its configured silence wait by 160 ms. Brief pauses/backchannels remain protected by tests; the 30-second continuous-input case still commits only after a real pause.
- ASR arriving before its manual commit acknowledgement is buffered by input ID. A current neutral placeholder can receive one confident context correction with a fresh performance cue ID; stale/past/meaningful cues are protected. Queue overflow preserves the terminal transcript event.

## Recorded browser checks

These are existing Cedar recordings replayed in the approved in-app browser, not fresh model replies or microphone sessions. Rendered SVG eye geometry, head/body transforms, captions, playback time, variants, and effect particles were sampled. Screenshots were inspected during surprise, care, curiosity, teasing, and celebration. The compact evidence is in [the JSON record](presence-latency-2026-08-27.json); the reusable runner is `scripts/browser-recorded-performance-qa.mjs`.

| Recording | Duration | Observed result |
| --- | ---: | --- |
| Surprise, then care | 9.00 s | Four authored semantic cues each retained one base variant. Before the fix, the opening surprise alone cycled through four. Two care phrases use distinct compatible deliveries; the last question changes to curiosity. |
| A little celebration | 5.35 s | Three same-family deliveries at phrase-tick boundaries. One confetti episode, approximately 0.31–2.03 s; at most four visible particles. |
| A bit of teasing | 5.25 s | Playful face, then a same-family phrase variation. One sparkle episode, approximately 0.31–2.00 s; no repeated effect loop. |
| A softer moment | 3.85 s | Concerned soft-down/return deliveries. No bright celebration effect. |
| Curiosity | 3.65 s | Asymmetric curious face with a phrase-boundary variation. No incidental effect. |

All five recordings completed; no browser console errors or visible alerts were observed. The multi-phrase replay retained head rotations up to about 33.5 degrees. This is not a claim that large motion alone reads as good acting, nor a claim of human-rated expression accuracy.

## Regression checks

- `npm test`: **388 tests / 37 files passed**.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- New/strengthened coverage includes stable phrase ownership, responsive entry, continuous cue reversal, independent word accents, intent filtering, empathy silhouette preservation, pre-ACK ASR ordering/overflow, stale-input rejection, and late-context correction reaching the actual rendered performance controller.

## Remaining acceptance limits

- The normal preview currently denies microphone access. No permission was changed. The preceding live-provider pass also reported exhausted credits; no provider requests were made during this pass.
- The 160 ms reduction is a configuration/test result. End-to-end live response latency, room noise, real talk-over handoffs, and perceived voice quality need a fresh microphone/speaker check.
- Recorded scenes have existing word timing or estimated captions. This does not prove exact synchronization for newly generated Realtime speech, and it does not revalidate the latest short-thought persona.
- DOM polling is not a 60 fps capture. Continuous retarget behavior is covered by simulation tests plus rendered spot checks; subjective naturalness remains an acceptance check with the user.

The modern-product-ui validation contract guided the continuous-state and rendered checks. The approved minimal dark interface was left unchanged.
