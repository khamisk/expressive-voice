# Conversational delivery and reaction responsiveness

## Scope

Keep the existing tiny dark interface. This pass changes spoken behavior,
recognition latency, and character effects, not the page layout or controls.

## Observed causes

- Actual generated replies included a long explanation for a casual factual
  question, canned reassurance after a correction, and unsolicited planning
  after bad news. The language audits record these failures, not just the
  intended persona. See [persona-text-audit.md](persona-text-audit.md) and
  [conversation-quality-audit.md](conversation-quality-audit.md).
- Turn reactions were labeled as assistant performances, so the controller
  waited for output audio even after understanding the user.
- During overlap, interpretation did not begin until the old voice handed off.
- Entering the thinking phase cleared a recognition that had already arrived.
- Every reaction began with another neutral/attentive prelude before reaching
  its semantic face. Effects had a separate half-second gate and long cooldown.
- A delayed user reaction could appear after a newer acknowledgement such as
  "yeah". The new input invalidates that recognition without invalidating the
  old assistant's still-audible phrase plan.

## Interaction coverage

| Change | Trigger and continuity | Failure / reversal | Reduced motion | Evidence |
| --- | --- | --- | --- | --- |
| Early recognition | Final user transcript, then validated director result; smoothly retarget the existing face before voice starts | Failed/partial transcripts do not infer mood; newer input and ended turns reject stale results | Same recognition without head travel | Transport and controller regressions; real text-only director checks |
| Overlap recognition | Interpret confirmed new input while old speech continues; retain the prepared result until handoff | Old spoken performance keeps ownership; failed analysis cannot block voice; backchannels retire stale recognition only | Same ownership/timing | Cached handoff, duplicate-event, stale-input, and backchannel regressions |
| Voice startup | Carry the recognized user cue through thinking into speaking | New input/start/end clears retained identity | Same state | Source check; rendered check unavailable |
| Phrase acting | Existing shared playback clock anchors the assistant's words and facial beats | Late whole-turn reactions cannot overwrite a newer phrase; word ticks cannot restart a held head gesture | Legible eyes, reduced body travel | Controller traces, rapid reversals, phrase ownership, and silent-output tests |
| Meaningful effects | One-shot recognition accents attached to the character: confetti, sparkle, heart, question, idea | Negative pivots retire incompatible effects; no replay or unbounded loop | Stationary, finite accent | Five provider scenarios, effect lifetime/geometry/reduced-motion tests |
| Reply style | Shared production persona used by the app and bounded real-provider audits | Retain context and respond to corrections; no invented human life | Not applicable | Captured language and audio-stream reports; final voice delivery not perceptually reviewed |

## Director checks with the real provider

`npx tsx scripts/audit-caption-director.mjs --effects` ran five text-only forced
function responses using the current director prompt, schema, and local validator.
It did not generate audio or use a microphone.

| Input meaning | Validated face / effect | First complete valid cue | Response complete |
| --- | --- | ---: | ---: |
| Warm thanks | Relieved / heart | 641ms | 669ms |
| Genuinely puzzling contradictory sign | Confused / question | 663ms | 694ms |
| Explicit realization about a crash | Relieved / idea | 674ms | 699ms |
| Vulnerable bad news | Sad / none | 664ms | 689ms |
| Ordinary coffee update | Neutral / none | 648ms | 681ms |

All five matched their allowed effect outcomes. The provider reported 5,181 input
and 221 output tokens across these requests. Times begin at the director request,
after its session is ready; they exclude microphone transcription and do not
measure speaker-to-face latency or rendered visibility.

The controller's 16ms-step tests reach semantic recognition at approximately
128ms after a valid user cue. An eligible effect object can begin then too; its
opacity still eases in, so this is not a 128ms visual-reaction claim. Effects use
a 2.4-second cooldown (previously 8.5 seconds), retain one-shot/one-per-turn gates,
and require a source-grounded high-confidence semantic fit. Ordinary questions
do not automatically get question marks; ordinary explanations do not get bulbs.

## Controller and transport evidence

A 240ms word-clock trace reaches 31.97 degrees of head roll, 21.22 body-X units,
20.70 body-Y units, and scale 0.916–1.049. It contains 313 distinct eye outlines,
not 313 reviewed emotions. Head gestures keep their own authored timeline while
eyes articulate, rather than restarting before the head can reach its target.

Focused regressions cover voice starting independently from analysis, recognition
before audio, prepared cues held across overlap, latest-input fencing, failed ASR,
closed/ended sessions, late user cues after an assistant phrase, and duplicate
function-argument events. The backchannel regression also proves the still-audible
assistant phrase plan remains eligible.

Effect bounds are checked with head rotation up to 32 degrees, body offsets up to
21 units, and scale 1.12. The SVG deliberately permits a small above-head accent
outside its viewBox; the tests check finite drawing clearance rather than forcing
the effect inside the white face. Actual viewport clipping remains unchecked.

## Final implementation checks

- `npm test`: 208 tests across 23 files pass.
- `npm run typecheck`: passes.
- `npm run build`: passes.
- Development listeners are running on 5173 and 8787. This is a listener check,
  not a browser or microphone check.
- `.env.local` remains ignored. No project-key markers were found in the built
  client, documentation, or performance artifacts.

The final four-turn language study verified that `session.updated` echoed the
exact production prompt (SHA-256 prefix `0c00030f0f6c8599`). Its factual answer was
29 words, correction 5 words, joke 24 words, and bad-news reply 43 words. The
correction was simply "Ah, next Thursday. Got it." The bad-news response still
appended unsolicited help and "sit with it" phrasing. That remains a style
failure, not a solved outcome. The complete wording and the earlier failed
iterations are preserved in [persona-text-audit.md](persona-text-audit.md).

These checks validate the code and specific generated examples. They do not
establish that every conversation will be natural or that the current voice
delivery matches the character's rendered performance.

## Acceptance limits

Browser verification remains blocked by the approved browser's security policy.
No alternate browser or automation surface is used to bypass that restriction.
Provider recordings, controller traces, and unit tests do not establish current
rendered quality or physical microphone/speaker behavior.

End and restart the conversation to receive a changed server persona. Existing
Realtime sessions retain their original instructions. Caption and acting timing
still share an approximate local playback clock, not provider word timestamps;
this pass does not establish word-perfect synchronization.
