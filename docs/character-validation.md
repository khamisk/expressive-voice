# Character performance validation

## Scope

White eye-only character, dark canvas, one conversation action, two display switches.
No eyebrows, mouth, camera orbit, or ambient reaction loop. The updated direction
explicitly allows bold, authored head/body gestures that follow spoken phrases.
Recorded fixtures are explicitly development studies. They never supply live replies.

## Resumed pass: 2026-08-27

Current implementation changes are being validated separately from the earlier
rendered results below. **The Codex browser rejected the local preview with a
browser-security-policy block during this pass.** No alternate browser, host,
proxy, or raw debugging connection was used to bypass that block. Consequently,
current visual acceptance, microphone talk-over, and speaker audibility remain
unverified. A compilation or simulated event test is not a substitute.

The later conversational/reaction pass is documented in
[conversation-reaction-validation.md](conversation-reaction-validation.md):
recognition before voice, retained handoff cues, held head gestures during word
accents, additional meaning-gated effects, and captured persona checks.

### Current interaction coverage

| Change | Trigger / visible state | Continuity and recovery | Current evidence |
| --- | --- | --- | --- |
| Replacing spoken captions | Validated model-authored thought boundaries, with punctuation/lookahead fallback | Short questions stay together; no article/possessive or one-word tails; no overlapping outgoing sentence or scrolling paragraph | Pure window/model-plan tests + static React markup tests; responsive wrapping review blocked |
| Caption pacing | First audible output, local device playback clock, and reported output-audio duration | One absolute word/phrase timeline; visible ink at release, without a word fade; future timing corrections preserve released words; local audio tail drains before finish | Clock/event-order tests and two real provider recordings; live word alignment remains approximate |
| Natural talk-over | VAD + real input meter + cumulative transcript + assistant phrase/quiet boundary | Quiet acknowledgements keep playback; substantive input waits for a boundary/pause, then 140 ms fade; finite safety fallback; end cancels pending work | Policy and transport regression tests; physical microphone test blocked |
| Phrase and word acting | New semantic cue, shared playback word/phrase ticks | Held authored gestures plus faster eye accents; longer context-specific arcs; distinct confetti/sparkle/heart choreography; continuous pose/velocity and finite recovery | Performance and geometry tests; current visual/naturalness review blocked |
| Recorded studies | Scene selection and audio playhead | Same replacing captions; long study uses recorded word times, older short studies explicitly estimate times | Existing five recorded outputs; component integration and type checks; playback review blocked |
| Spoken input QA | Development-only `?voiceQA=1`, six labeled input buttons | Real input track for a live Realtime session; no microphone claim; cancel fetch/playback; close stops the track | Six TTS input WAVs generated (25.342 seconds); track injection/lifecycle tested with fakes; browser end-to-end run blocked |

Research grounding:

- The [reference avatar source](https://github.com/smontlouis/bible-strong-avatar-lab)
  uses independent eye geometry and timed expression transitions. The new acting
  preserves those readable shapes and stages deliberate head/eye beats.
- Animator Dana Boadway-Masson's [facial acting guidance](https://www.animationmentor.com/blog/facial-animation-101/)
  distinguishes readable holds from abrupt emotional switches and relates facial
  timing to dialogue. This informed the review of the fast word clock: head beats
  need enough time to reach their pose, while eye accents can change more often.
  The result is deliberately exaggerated, as requested, rather than a claim of
  physically accurate human facial animation.
- [OpenAI's Realtime prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
  informed concise delivery and variety constraints. The shared production persona
  has since been revised using captured conversation replies; current instructions
  live in `server/voice-persona.ts`, and provider evidence is recorded separately.
- [Realtime conversation controls](https://developers.openai.com/api/docs/guides/realtime-conversations)
  distinguish cancellation from clearing buffered audio. For WebRTC, clearing
  unplayed output also truncates provider conversation context. The local reaction
  context is separately trimmed to the displayed audible prefix.
- [Realtime token accounting](https://developers.openai.com/api/docs/guides/realtime-costs)
  documents approximately 50 ms per assistant audio token. That supplies a
  duration estimate for caption pacing, not precise word timestamps.

### Remaining acceptance checks

The first resumed pass passed **124 tests in 17 files** and the production build.
The subsequent caption/timing follow-up and its current evidence are documented in
[caption-sync-validation.md](caption-sync-validation.md). The geometry matrix covers 19 semantic
faces × 7 gestures × 18 accents (2,394 combinations), not 2,394 perceptually
reviewed expressions. Additional acting tests use 240 ms word ticks, rapid
retargets, silent output, reduced motion, and negative-emotion guards.

That earlier pass's explicit-tilt trace, with a word tick every 240 ms, reached 33.55° of
head roll and 23.40 body-X units. Eye accents continued while the authored head
gesture held its own timeline; after a pause both head and body settled. These
are measured controller values, not a rendered or perceptual approval. Newly
added event-order tests also cover auxiliary-ASR failure, stale input item IDs,
deferred reaction context after a correction, late plan timeouts, unexpected
data-channel closure, and audio-backed caption timing.

1. Re-enable the task's approved browser access, then inspect the main conversation
   at 390×844, 360×800, and the desktop preview. Check large tilted poses for clipping.
2. Play the recorded studies with mood/captions hidden for part of the review.
   Check if concern, delight, surprise, and playful disbelief read without labels.
3. Use a real microphone and audible output: brief “yeah,” a mid-sentence correction,
   a deliberate “stop,” and sustained speech. Verify audibility and perceived handoff.
4. Run the labeled recorded-input QA against the live provider as a repeatable
   complement to, not a replacement for, the physical microphone session.

## Previous-build interaction coverage

The evidence in this section predates the resumed pass. It is retained for
comparison; it does not verify the newly changed captions, acting, or handoff.

| Object | Trigger and states | Continuity / feedback | Recovery and accessibility | Evidence |
| --- | --- | --- | --- | --- |
| Conversation button | Idle → connecting → listening/speaking → idle | Stable footprint; press compression; pending indicator; green start/red end | Native button, focus ring, duplicates blocked during connect; inline error and restart | Real WebRTC output across four turns; end returned to idle |
| Mood switch | Visible ↔ hidden | Traveling thumb, interpolated track, label footprint retained | Native labeled switch; keyboard; reduced-motion paint-only equivalent | Live DOM samples captured intermediate thumb positions between 18 px and 0 px |
| Transcript switch | Visible ↔ hidden | Bubble keeps mounted content and fades/moves in same slot | Does not replay text, reset face, or restart audio; hidden copy removed from accessibility tree | Completed live reply remained identical across hide/show; output energy stayed zero |
| Face | New contextual cue, phrase start, actual voice onset, pause, turn handoff | Persistent paths; critically damped pose + velocity; eye silhouette + head/body gesture + finite accent | Stable attentive fallback; no emotion classification from keyword matches; reduced travel | Unit continuity checks + recorded scenes |
| Effects | High-confidence earned cue during audible speech | At most 3 local particles; continuous birth/lifetime/fade; once per turn and cooldown | Negative/uncertain/late cues suppressed; interruption fades; reduced motion uses one stationary accent | Unit one-shot and gating checks |
| Recorded scene buttons | Choose/replay scene; switching during playback | Press compression, stable selected surface; same character interpolates from visible pose | Native buttons, named scenes, labeled recorded-source boundary; stop playback; error/retry | Five actual Cedar WAV files, 27.1 seconds total |
| Live typed QA input | Send text into a live Realtime session | Immediate input clear; real voice/phase feedback | Development query only, clear test label, disabled while disconnected | Real-provider win, correction, ordinary turn, and multi-phrase story checked |

## Technical and perceptual checks

- Contextual model output must arrive before playback ends; a neutral timeout is not a successful expressive test.
- Realtime out-of-band metadata/text/done/errors cannot alter voice generation or playback state.
- Brief acknowledgements must not cut output; sustained input must not be ignored.
- Captions must not accelerate because the model generated ahead. Pauses follow output audio; completion flushes once.
- Muted neutral/curious/surprised/amused/concerned silhouettes must remain distinguishable.
- At a reaction reversal, sample both pose and velocity; do not accept endpoint-only tests.
- Live testing must include a positive event, ordinary conversation, and a correction or negative event.
- Do not claim exact word alignment: the current Realtime transport does not supply word-level playback timestamps.

## Previous-build results

Five real Cedar recordings are available, including a nine-second, four-phrase study. They are mono 24 kHz 16-bit PCM WAV. The longer study uses Whisper word timestamps to place surprised/lean-in, concerned/tilt-left, concerned/nod, and curious/tilt-right cues. A second proposed long recording did not complete within the recorder's retry cap and is not represented as an available scene.

Rendered checks:

- Main app at 390×844: document and scroll width both 390, height 844, primary button bottom 713. No overflow.
- Main app at 360×800: document and scroll width both 360, height 800, primary button bottom 680. No overflow.
- Expression gallery and recorded studies operated in the 760×825 Codex preview.
- Transcript hide/reveal retained exactly the same completed live text; no replay, new cue, or audio restart. Full-motion switch sampling captured the actual thumb travel: 18 px, 16.01 px, 12.32 px, 7.94 px, then progressively to 0 px. This verifies rendered intermediate states, not just the declared 220 ms CSS transition.
- The nine-second study advanced all four cues at its recorded phrase boundaries. A rendered concerned tilt reached about 21 degrees, and the physical circle moved with it. A 318-frame DOM geometry trace had a maximum frame-normalized eye-bound change below 0.056 of the reference width.
- Gentle delivery produced no effects. The positive recording produced at most three visible particles, once; ending playback returned to attentive rest and zero audio energy.

The composability matrix checks 19 faces × 7 gestures × 11 accents for finite, bounded, renderable geometry. That is technical safety coverage, not perceptual approval of every possible pairing.

### Final live-provider pass

The following turns ran consecutively in one real Realtime session on 2026-08-27. Input was typed through the labeled development control; output was real provider voice with nonzero playback metering.

| Input | Observed performance | Reply / outcome |
| --- | --- | --- |
| “I finally got the job I really wanted!” | Joyful recognition, one confetti effect, then delighted/nod/spark during speech | “That’s fantastic news, I’m really glad for you.” |
| “Actually, it was a rejection. I misread it. I did not get the job.” | Sad reaction replaced the positive cue; concerned/nod/soften phrase; no celebration | “Ah, that’s a tough misread, and I’m sorry it turned out that way.” |
| “I made toast for breakfast.” | Neutral reaction, then a neutral nod; no stale sadness or effects | One short response, then listening |
| Four-sentence robot/toast story, at most 35 words | Neutral opening → concerned/tilt-left → surprised/tilt-left → playful/nod; distinct accents; no effects | Three spoken phrase changes observed at about 3.14, 5.35, and 7.44 seconds after Send; listening by 9.44 seconds |

The live story reached about 21.6 degrees of head roll and 11.3 degrees of nod. A late plan for its opening sentence was skipped instead of replayed. The later three clauses each received a current phrase cue. After the final reply, toggling captions preserved the complete text and left the character at attentive rest with zero output energy. Ending the session returned to the normal Start talking state.

Verification: **69 tests in 13 files passed**, and **`npm run build` passed**, including TypeScript checking. Tests include 420 ms acknowledgement tolerance, sustained interruption after generation has finished but audio is still playing, out-of-band error isolation, final short-clause planning, and continuous retargeting. The final phrase matrix covers 1,463 combinations at two sampling moments each.

A final lifecycle audit also fixed closing during connection setup: pending requests are aborted, late callbacks cannot revive a closed session, and a microphone stream returned after cancellation is stopped immediately. Two focused fake-browser tests cover cancellation during microphone permission and offer negotiation, without making provider calls.

### Limits

- The recorded studies have authored, word-timed cues; live cues are independently model-directed and approximately aligned to the audio-gated caption cursor. These are not equivalent synchronization guarantees.
- Short or fast phrases can finish before their nonblocking plan arrives; stale cues are intentionally skipped. Not every live phrase is guaranteed its own gesture.
- Talk-over policy was checked with event-level tests, not a physical microphone conversation. Device echo cancellation, speaker audibility, and subjective naturalness still need a person using the target device.
- Geometry checks and movement bounds do not establish that all combinations are perceptually convincing. The five rendered studies and the live cases above are the actual reviewed examples.
