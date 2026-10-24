# Reaction accents and conversational delivery: 2026-09-17

## Scope

Kept the minimal conversation screen. Added `pop` (surprise) and `laugh`
(amusement) to the existing confetti, sparkle, heart, question, and idea
vocabulary. The native character tool can select each effect. Negative and
vulnerable expressions still reject these decorative effects.

The existing expression gallery now has explicit replay controls for all seven
effects. A compatible selected face is preserved; incompatible selections switch
to an appropriate face. Preview clicks bypass the live conversation's effect
cooldown, but not compatibility or once-per-cue behavior. The narrow Codex pane
has a larger, vertically arranged preview and room above it for particles.

## Why the character was parked

The recorded softer scene initially held head `0,0,0` and body
`0,0,1,1,1` throughout 55 observed samples, approximately 0.24 to 2.8 seconds
into playback. Only the eyes changed. An omitted gesture could inherit `still`,
and an anchored gesture could finish without later phrases owning a new one.

The revised controller uses semantic defaults for omitted gestures, allows a
later phrase to own a finite gesture, and preserves that ownership across word
ticks. Explicit `still` is respected. The first spoken beat blends from an
existing pre-audio reaction; fresh semantic cues do not pay a second entry tween.

Post-change observations of the same recording showed visible movement, for
example head roll from about -10 to -20 degrees over 0.27 to 0.91 seconds. This
is evidence that motion reaches the rendered character, not an objective claim
that every pose looks human. Variants differed between runs.

Visual inspection also found that every amused reaction automatically visited
skeptical and playful silhouettes. Amusement now develops its smile without that
forced skeptical detour. Teasing remains available through the playful family.

## Live provider check

Used the real app's fresh WebRTC sessions with typed test input and real provider
audio. No microphone permission was requested. Four short replies were generated;
both sessions were explicitly ended. The final session's displayed provider
instructions contained the new playful-reply capability instruction.

| Test | Actual reply | Words | Rendered behavior |
| --- | --- | ---: | --- |
| Got the wanted job | “Oh, hell yeah. You really wanted that one.” | 8 | Delighted lift, confetti, finite return |
| Offer withdrawn after telling family | “Oof, that’s rough, especially after sharing the good news. I’m sorry you had to walk that back.” | 17 | Concerned tilt, no decorative effect |
| Code joke, before capability refinement | “That’s a very dramatic break. Sounds like your code took ‘rest’ as a project plan.” | 15 | Model skipped its face tool; fallback was neutral. **Mismatch found.** |
| Code joke, fresh session after refinement | “Seventeen issues? That’s not a break, that’s a dramatic plot twist. Your code took a vacation and came back with gossip.” | 21 | Native amused/laugh beat, then anchored playful/nod/wink beat; visible laugh effect |

The last reply still adds a second joke and is longer than the ordinary target.
Shortness is a behavioral prompt, not a hard word cap. The second joke run used
a fresh context, so this is a successful follow-up sample, not a controlled A/B
proof or a guarantee of consistent future selection. The final smile-only
amusement refinement was checked locally and in the gallery after this audio run.

## Rendered effect checks

Operated all seven gallery controls in sequence. Each selected a compatible face
and produced visible SVG particles: confetti 4, sparkle 4, heart 2, question 2,
idea at least 2 during its staggered reveal, pop at least 2 during its staggered
reveal, laugh 4. Inspected screenshots of confetti and laugh in the Codex pane.
Reloaded the preview after detecting a historical Vite HMR connection error, and
verified the corrected amusement silhouette in the freshly loaded renderer.

Added integration coverage through native tool parsing, cue scheduling, the
actual performance controller, and effect sampling. Coverage includes silent
pre-audio reaction delivery, audio-gated anchored effects, one-shot expiry,
negative-effect rejection, rapid explicit gallery replay, and readable amused
eyes. Existing reduced-motion and geometry-bound tests remain in place.

## Limits and next acceptance check

- Physical microphone, echo cancellation, subjective speaker quality, and exact
  word/audio synchronization were not verified in this pass.
- No transport or interruption policy was changed.
- The character still has 152 existing variations across 19 feelings; the new
  work is better delivery and two new effects, not hundreds of new expressions.
- Ask the user to compare the seven reaction accents and a few live moments.
  Their perceptual acceptance remains open. More sample interactions are needed
  before claiming reliably human-like behavior or consistently short replies.

Verification: full suite 464 tests across 42 files, typecheck, and production
build pass. Vite retains the non-blocking roughly 507 kB main-chunk warning.
