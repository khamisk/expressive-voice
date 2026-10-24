# Voice interaction fixes: 2026-08-27

## Current result

The implementation and local regression pass are complete. Final full suite:
**339 tests in 33 files passed**, TypeScript passed, and the production build
passed. The tiny live UI is unchanged.

Five real-provider phrase cases completed in the approved in-app browser. The
next overlap case failed before producing audio with **"You have no credits
remaining"**. No further provider calls were made. The last prompt refinement,
structured-humor fix, and neutral-placeholder refinement have local regression
coverage but have **not** been retested against the live provider.

Current prompt SHA-256 prefix: `3980c529936c7764` (3,696 characters, checked
locally). The five completed live cases used the preceding prompt
`88db57101d19f350`, whose session echo had been verified. Do not describe the
current prompt as provider-verified.

## Changes made

- **Talk-over ownership:** disable provider turn detection and commit microphone
  turns from the local detector. Speech onset alone never cancels the reply.
  Brief acknowledgements and substantive topic changes use the existing
  transcript-aware handoff controller. Missing ASR gets a bounded handoff that
  prefers a real pause/phrase boundary; it cannot wait indefinitely.
- **Input robustness:** calibrate the noise floor while connecting, preserve it
  at channel-open, keep pre-roll during onset, and remove the 25-second cap from
  the live detector. Long speech ends at a real pause. Commit acknowledgements
  are correlated; a missing acknowledgement fails explicitly after 3.5 seconds.
- **Playback recovery:** an unsolicited output clear stops the speaking meter
  and removes unheard queued captions. It cannot leave the character silently
  "speaking" forever. Response IDs fence late/unrelated output events.
- **Earlier meaning:** complete generated phrases prepare a conservative cue
  before playback. The same playback clock releases captions and acting, with
  a small acting lookahead. Explicit finalized first-person wins/losses can
  react immediately; ambiguous, reversed, and mixed news stays with the director.
- **No flat placeholder lock:** a neutral/explain fallback can be refined once
  by a confident authored cue while that phrase is still audible. Meaningful,
  completed, superseded, duplicate, or silent beats do not replay.
- **Humor and emotional safety:** high-confidence structured joke intent with
  a valid current anchor no longer requires literal words like "funny". Negative
  and mixed context still blocks cheerful effects; speech beats never add effects.
- **Shorter voice direction:** one brief ordinary thought, no coaching signoff,
  automatic offer, forced "win," or invented blame. Explicit requests for detail
  can still expand. This is behavioral guidance, not a guaranteed word limit.
- **Caption lifecycle:** clear the old caption/word clock before a new response
  begins thinking. Visibility does not own playback. QA now exposes the full
  presented transcript so sampled caption fragments are not mistaken for a
  complete word count.

Client-owned WebRTC turn commits follow the official
[Realtime conversation controls](https://developers.openai.com/api/docs/guides/realtime-conversations)
and [turn-detection configuration](https://developers.openai.com/api/docs/guides/realtime-vad).
This does not claim access to ChatGPT's private voice implementation.

## Live phrase evidence

Case files are in [live-fix-cases](live-fix-cases/). They contain DOM-visible
captions, cues, measured output RMS, phase transitions, and bounded transport
diagnostics, not credentials. All five ended naturally without an app error.

| Case | What was observed |
| --- | --- |
| [Job win](live-fix-cases/win.json) | Confetti and delighted recognition; three short thoughts still included an unnecessary "enjoy it" signoff. |
| [Rejection/correction](live-fix-cases/rejection.json) | Concerned speech, no celebration. "Jerked around" assigned unearned blame after the user said they misread the email; the final persona addresses this. |
| [Coffee update](live-fix-cases/coffee.json) | Neutral face and no effects. A padded second thought called the ordinary update "a win"; the final persona addresses this. |
| [Mixed feelings](live-fix-cases/mixed-feelings.json) | No confetti; neutral opening moved to concern on "feel sad about leaving." |
| [Joke](live-fix-cases/joke.json) | Reply played normally, but every speech cue was neutral. This exposed the over-restrictive humor guard and placeholder-priority problem fixed afterward. |

In each case, the first assistant speech cue and first above-threshold audio
appeared in the same sampled frame. Median sampling intervals were 88–93 ms.
This is evidence against the earlier 1.16–2.63-second first-cue delay, **not**
proof of zero latency or exact word/audio alignment. The early harness sampled
visible caption windows; `sampledWordCount` is not a complete response counter.

[The final brief-yeah attempt](live-fix-cases/brief-yeah.json) is explicitly a
failed/billing-blocked test: no audio, no recording injected, no overlap pass.
Earlier intermediate-build recorded-input trials observed an uninterrupted
"yeah" and a completed correction handoff, but they are not a final-build
acceptance result. A separate multi-case harness call timed out and reset its
kernel; those unpersisted cases are excluded, not counted as passes. Total
provider billing for this work was not measured and is not inferred here.

## Offline and recorded-browser evidence

- [Surprise/care replay](live-fix-cases/recorded-surprise-care.json): an existing
  nine-second recording completed through surprised → concerned → curious →
  attentive, with no celebratory effect. Screenshot inspection confirmed large
  eyes and visible head staging. These were authored cues, not a fresh model test.
- [Celebration replay](live-fix-cases/recorded-celebration.json): the existing
  5.35-second clip completed; confetti appeared, at most four particles were
  visibly sampled, and the effect returned to none with no particles at the end.
- [Caption toggle](live-fix-cases/offline-caption-toggle.json): in an explicitly
  static offline preview, hide/show preserved the finished caption, window index,
  and word tick. The switch had its 220 ms transition and correct end states;
  the browser click completed after the transition, so no intermediate thumb
  frame is claimed from this capture.
- Automated coverage includes noise calibration/outliers, continuous speech
  beyond 30 seconds, commit/ASR failures, brief backchannels, current-response
  fences, phrase-boundary handoff, early/silent/late cue handling, negative
  effects, exact caption grouping (including "on your side"), motion continuity,
  and face/gesture/accent combinations.

## Remaining acceptance work

1. Restore API credits, then rerun the final persona/humor changes and the saved
   brief-yeah, correction, and new-topic overlap scenarios, one bounded case per
   invocation. `scripts/browser-live-qa.mjs` provides the browser-only harness.
2. Test a physical microphone with headphones and speakers in the real room.
   Recorded-input tests do not prove echo/noise handling or actual listening feel.
3. Review caption/audio/face timing perceptually on fast, slow, and paused replies.
   Public Realtime transcript events are not a word-playback timestamp stream;
   timing here remains estimated, not a 100%-sync claim.
4. Judge emotional readability with labels hidden. A passing geometry matrix or
   a large number of expression variants is not evidence of human-like acting.

No claim is made of physical-microphone testing, human speaker listening,
final-provider acceptance, exact word synchronization, or parity with ChatGPT.
