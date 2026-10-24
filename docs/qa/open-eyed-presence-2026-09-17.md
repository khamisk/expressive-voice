# Open-eyed friendly presence, 2026-09-17

## Scope

User rejected the permanent closed-smile eyes after the Friendly effect change.
Joyful, amused and relieved now have substantial open-eye resting portraits.
Explicit reaction and speech beats close into a brief smile, then reopen over
the same spring-driven face. Negative expressions and authored head gestures
retain their meaning; this is not an automatic neutral reset for every emotion.

The gallery now separates facial cue identity from effect preview identity.
Friendly, Sparkle and other effect clicks do not change the face, replay its
smile, or restart its head gesture. Replay expression deliberately replays both.
Gallery-only effect inspection can overlay any face; live semantic guards still
reject inappropriate positive effects on negative/vulnerable moments.

## Rendered checks

- In the Codex pane, selected Joyful and replayed its full sequence. A 168-frame
  DOM observation captured a smile peak of 0.886 and a settled value of 0.199
  around 2.9 seconds later. Screenshots confirmed a brief crescent followed by
  large open eyes, not a permanent grin.
- On Neutral, clicked Friendly then Sparkle. Both kept the exact facial cue
  `gallery:neutral-present:0`, its selected label, and smile 0.000. Friendly's
  golden greeting mark rendered over the open-eyed face.
- Checked finite smile/reopen, unchanged cue and geometry during effect
  switching, interruption continuity, and reduced-motion contracts locally.

## Bounded live checks

Used the real app's WebRTC voice session with typed input, then one existing
recorded correction fixture. No physical microphone was requested. Output RMS
confirms audio reached the browser; this is not a subjective speaker-quality
or exact word-sync assessment. Session was explicitly ended after the checks.

| Input | Observed response/face | Peak to final smile |
| --- | --- | --- |
| Casual greeting | Neutral/curious, no effect; reply began “Hey! I'm doing well” and ended with a question | 0.024 to 0 |
| Code took a break and opened seventeen issues | Amused, laugh effect, then reopened; two short joke sentences | 0.975 to 0.219 |
| Offer withdrawn after telling family | Concerned, no decorative effect; acknowledged the family detail | 0.029 to 0 |
| Interview rescheduled, not offer withdrawn | Neutral/attentive, no effect; acknowledged correction | 0.025 to 0 |
| Recorded “Actually, I got that wrong. It was a rejection, not a win.” during a first-day pep talk | Delight changed to concern, no effect during concern; diagnostic handoff `output_boundary` | Final 0 |

The final overlap reply was: “Oh, I’m really sorry to hear that. Let me respond
gently.” The second sentence is an observed remaining style failure: the voice
narrates its delivery instead of just replying. No persona or transport changes
were made to conceal this. The joke and bad-news replies also still used two
sentences; this pass does not claim universal brevity or natural conversation.

## Regression

- 45 files / 490 tests pass.
- Typecheck and production build pass.
- Existing main-bundle size advisory remains.
- No API credentials or raw session data were written into this report.
- User perceptual acceptance remains open.
