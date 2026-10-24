# Expressive voice: current status and next acceptance checks

## Resumed 2026-09-17: reaction accents and shorter turns

Added surprise pop and laugh accents, an inspectable seven-effect replay strip
in the existing gallery, and more legible narrow-pane preview framing. Fixed
phrase gesture ownership so longer replies do not automatically park after the
first head beat; word ticks keep the gesture running rather than taking it away.
Amusement no longer automatically turns skeptical halfway through a laugh.

The persona now prefers one short spoken thought. Four live typed-input/real-
voice checks produced 8, 17, 15, and 21-word replies. A neutral face on a joke
was found, and a fresh-session follow-up selected amused/laugh plus an anchored
playful beat after capability guidance was refined. Shortness and meaning fit
are improved samples, not guarantees. Physical-microphone QA and user acceptance
remain open. See [reaction and delivery QA](docs/qa/reaction-accents-2026-09-17.md)
and [bounded persona study](docs/qa/conversation-2026-09-17.md).

## Next session: the performance is still not accepted

Latest feedback after the native-character pass: he is not animated enough,
feels parked in one place doing nothing, and some faces do not match the moment.
The next pass is about the visible result, not another successful test count.

- [ ] Give the eyes, head, and circle more sustained, varied acting while talking
      and listening. Avoid long dead holds; movement must have a conversational
      reason, not become random panning, jiggling, or a repeated animation loop.
- [ ] Make expressions evolve within a spoken thought and fit its meaning and
      tone. Find mismatched, stale, missed, or late beats in real interactions.
- [ ] Inspect complete speech-and-motion clips: measure how long poses remain
      unchanged and whether selected beats actually reach the rendered character.
      Review with labels hidden; repair weak faces and timing before calling the
      performance convincing. Keep the minimal UI and large friendly eyes.

Saved for the next working session. No automatic run is scheduled, and no
runtime behavior was changed while recording this feedback.

## Resumed 2026-08-27

Implementation is in place for short replacing captions, dramatic phrase/word
acting, varied idle glances, and transcript-aware talk-over handoffs. The voice
now knows it controls the character: an optional native tool selects meaningful
multi-beat expressions, gestures, and effects, with feedback from the actual
rendered frame. Explicit silent expressions are supported. The minimal UI is
unchanged. See [native character QA](docs/qa/native-character-2026-08-27.md).

The approved in-app browser and live provider now work. This pass verified
silent skeptical acting, surprise plus speech, short news replies, recorded
brief acknowledgement/correction, and a typed topic switch during real audio.
It found and fixed two handoff lifecycle bugs: clear-before-cancelled-done could
strand the new reply, and a stale silence timer could freeze its captions and
acting. The final live repeat passed. Latest local regression: **441 tests /
40 files**, TypeScript, and production build pass.

The latest presence fix stops word ticks from restarting the phrase's face/head
performance, removes timer-driven variant reselection, restricts variations by
meaning, and preserves the empathy silhouette. Late context corrections now
update the actual face, not just its label. Live input release is 420 ms instead
of 580 ms; the end-to-end effect still needs a real mic test. See
[the presence and timing check](docs/qa/presence-latency-2026-08-27.md).

The latest fixes add client-owned turn detection with startup calibration and
no mid-utterance duration cap, recover from unsolicited audio clears, prepare
first speech cues earlier, and let a neutral placeholder accept a confident
current-phrase interpretation. The humor guard and short-thought persona were
refined from actual failing replies. See
[the current validation report](docs/qa/fix-validation-2026-08-27.md).

Earlier API-credit and preview microphone failures are recorded in historical
reports, not treated as current provider blockers. Real-provider QA succeeded
using typed prompts and existing recorded inputs; physical microphone access,
room acoustics, perceived speaker quality, and exact word synchronization are
still unverified. Startup errors distinguish microphone access, billing, rate
limits, and configuration failures. See
[startup verification](docs/qa/startup-failure-2026-08-27.md) for that earlier pass.

The caption follow-up removes the hard five-word split, validates model-authored
thought boundaries, and shares one device-playback timeline with acting. Two real
provider recordings exposed long sentence pauses and trailing silence; timing is
still estimated, not word-exact. See `docs/caption-sync-validation.md` for the
measurements and remaining acceptance limits.

The conversational follow-up moves validated recognition ahead of voice startup,
preserves it through handoff, adds meaning-gated question/idea accents, and revises
the shared voice persona using captured replies. Language/controller checks are
separate from perceived voice and visual quality; see
`docs/conversation-reaction-validation.md` and `docs/persona-text-audit.md`.

The latest variation pass adds eight variants per feeling, recent-use history,
meaning-preserving word articulation, and a silent individual-replay gallery.
The voice prompt now targets one short ordinary thought, and topic changes can
finish a nearby spoken boundary before handing off. Real provider wording,
offline recorded-PCM handoff evidence, and remaining browser/microphone limits
are in `docs/meaning-variation-validation.md`. Bad-news replies still sometimes
append an unsolicited offer; this is not marked as solved.

## Direction from Karim

The goal is a friendly, convincing physical character to converse with. Its voice,
face, head, and timing should feel like one performance. The current version still
feels too restrained and lifeless. **Start with much more exaggeration, movement,
and frequent micro-expressions. Tune down after seeing and hearing it, not before.**

Keep the tiny dark UI, white character, large friendly eyes, no brows or mouth,
one conversation button, and the two display switches. This is a performance and
conversation-quality pass, not a larger interface.

## 1. Short spoken thoughts and partial captions

- [ ] Confirm consistently short natural replies against the final persona.
      Latest live ordinary replies were 7, 12, 13, and 14 words; the factual
      topic-switch reply was 28 words. This is encouraging, not broad proof of
      consistent naturalness or elimination of unsolicited offers.
- [x] Show only a few words or the current short phrase at a time, like reading a
      script. Replace the visible fragment as speech advances; do not accumulate
      a scrolling paragraph in the bubble.
- [x] Keep complete conversation context internally. Hiding/showing captions must
      not replay words, reset timing, or restart a performance.
- [x] Fix chunk-boundary spacing such as `laugh.So` in the supplied screenshot.
- [ ] Align caption changes to what is actually being heard, not merely to text
      generation. Test slow, fast, paused, and interrupted speech.

Example of the desired pacing, not a canned response template:

> I'm so sorry to hear that happened.
>
> That really sucks.
>
> How do you feel about it?

Even these short sentences should contain several visible acting beats, and the
caption can reveal each sentence in smaller spoken fragments.

## 2. Much bigger, more frequent acting

- [ ] Dramatically increase the strength and frequency of eye and head acting.
      Multiple meaningful changes per sentence, including within a single mood.
      Controls exist, but the latest user review still finds the result too still.
- [x] Author anticipation, emphasis, brief holds, follow-through, and recovery.
      Use strong tilts, nods, dips, lifts, lean-ins, and expressive eye shapes.
- [x] Greatly expand the usable micro-expression vocabulary: asymmetric widening,
      softening, squints, winces, double takes, thoughtful glances, winks, eye rolls,
      and combinations that fit the current spoken beat.
- [x] Give eye rolls a conversational reason, such as playful disbelief; do not
      randomly insert them into empathy or other incompatible moments.
- [ ] Review the weak existing faces and replace or substantially rework them.
      More combinations alone do not prove that the expressions read clearly.
- [x] Preserve large, legible eyes and clear silhouettes. Maintain continuous
      position, shape, and velocity across retargets: exaggerated must not mean
      teleporting or abruptly switching poses.
- [x] Use small celebrations or other accents when the meaning earns them.
      Keep effects secondary to the acting, and never celebrate negative news.

## 3. Livelier idle and listening

- [x] Add natural-looking gaze changes, look-arounds, blink variation, posture
      changes, and small attentive reactions while listening.
- [x] Make these varied and state-aware. Avoid a conspicuous repeating camera
      tour or the same eye motion on every turn.
- [x] Transition smoothly from idle/listening into speech and back again.

## 4. Natural overlap and handoff

- [x] Stop treating an interruption as a reason for an abrupt audio cut. Review
      the current fixed 650 ms cancellation policy.
- [x] Continue hearing the user while speaking. Brief acknowledgements should
      leave the reply flowing; substantive overlap should lead to a natural
      transition or handoff, with the new user input retained and understood.
- [x] Investigate phrase-boundary handoff and the available Realtime controls.
      Match the requested conversational feel without assuming the website's
      internal implementation is exposed by the API.
- [x] Verify recorded brief acknowledgement and correction through live WebRTC,
      plus a typed new-topic redirect during playback. Preserve response identity
      until both cancellation and output clear settle. Ignore stale output timers.
- [ ] Test with real microphone input and audible output, including a short
      “yeah,” a correction halfway through a sentence, and sustained overlap.
      Typed-input tests and synthetic event tests are not sufficient here.

## 5. Research, review, and actual proof

- [ ] Revisit the supplied avatar references and study timing, staging, eye
      silhouettes, head poses, and speech-driven acting. Research additional
      character-animation approaches before another round of arbitrary tuning.
- [x] Use the modern-product-ui skill for the caption/control changes while
      preserving the intentionally minimal interface.
- [ ] Review several complete audio-and-motion examples: empathy with a follow-up
      question, a story with changing intent, playful disbelief, a genuine win,
      and a win corrected into disappointing news.
- [ ] Hide labels and captions during part of the review. The performance itself
      should communicate the reaction and follow the voice.
- [ ] Inspect real transitions and rapid reversals, not just endpoint screenshots.
      Check for repeated gestures, dead stretches, missed beats, and audio cuts.
- [x] Run the existing regression suite and build after changes. Keep a truthful
      record of what was tested live versus recorded or simulated.

References supplied by the user:

- [Avatar lab](https://avatars.bible-strong.app/)
- [Avatar source](https://github.com/smontlouis/bible-strong-avatar-lab)
- [First video](https://x.com/_smontlouis/status/2087476245944496576)
- [Second video](https://x.com/_smontlouis/status/2088167644809527308)
- [Third video](https://x.com/_smontlouis/status/2088255480657248440)

Existing implementation evidence and limitations are in
[docs/character-validation.md](docs/character-validation.md).

This file records the next session's work. It does not schedule an automatic run.
