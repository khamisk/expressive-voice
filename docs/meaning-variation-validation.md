# Meaning-driven expression variations and short turns

## Contract

Preserve the tiny dark conversation UI, white character, large eyes, no brows or
mouth, the start/end action, and both display switches. Expand the character's
authored vocabulary and improve turn taking; do not add conversation chrome.

The preceding read-only audit found three concrete faults: nine-entry coupled
expression cycles, a word-tick layer that erased chosen eye accents, and a soft
35-word target that still produced long replies. Two different authored eye
accents became identical across all 251 sampled frames when word ticks ran.

## Character implementation

The local bank has eight named performance variants for each of 19 semantic
feelings (152 entries). Shared timing rhythms combine with family-specific eye
geometry, intent tags, and finite accents. This is a composable vocabulary, not
a claim that 152 faces were individually judged by a human reviewer.

An intent such as comfort, question, joke, or explanation has several eligible
variants inside the same emotion. Recent-use history survives successive cues
and turns. Word ticks no longer change an emotion or erase a director-chosen eye
accent. Whole variants get a readable hold; quick word articulation does not
restart the head's gesture every 240ms. Retargets retain current pose and velocity.

A root audit also found the first replacement accent hash clustered adjacent
ticks: seven or more consecutive words could get the same accent. The picker now
mixes its hash fully and includes turn/cue/variant/intent context. A context-seeded
shuffled bag uses each eligible accent once before changing its order, avoiding
both raw-hash clusters and repeated fallback accents. Focused tests cover 100
ticks across 20 contexts for eight feelings, deterministic replay, per-context
variation, bounded repeated runs, and negative-emotion safety.

The development gallery uses static held-frame thumbnails sampled from the same
controller and a single live preview. Native feeling selection, variant buttons,
and replay make the available performances inspectable without a voice session.
Its static markup and controller tests are not browser interaction tests.

## Interaction coverage

| State change | Trigger / ownership | Continuity and recovery | Verification |
| --- | --- | --- | --- |
| Recognize a user's meaning | Validated user cue and intent | Select an eligible same-emotion variant; retain recent-use history across turns; no default attentive replay | Controller tests and two live provider recognition cases pass; perceived reaction latency not verified |
| Perform a spoken phrase | Word-anchored director cue | Authored eyes and gesture own the beat; small word/audio articulation cannot replace meaning | Explicit-accent priority, same-emotion beats, and nine live director cues pass |
| Change expression within a thought | New grounded clause intent | Retarget from current pose and velocity; never invent a new emotion from a counter | Same-time reversal, frame continuity, readable hold, and recent-history tests pass |
| Change topic while voice is active | Confirmed substantive new user input | Prefer a nearby spoken boundary, fade and remove unheard old material, answer latest input; brief acknowledgements retain old reply | Transport/policy tests and recorded-PCM probe pass; live microphone handoff remains unverified |
| Short reply | User's latest conversational intent | One short thought for everyday turns; detail when requested; no post-generation mid-sentence cutoff | Live text and bounded audio checks completed; bad-news unsolicited offer still fails the style target |
| Inspect variants | Existing development gallery, selection / replay | Stable preview, native buttons/select, authored press/focus/selection styles, same live renderer, no microphone or generated audio | All 152 static thumbnails and one live preview verified in markup/controller tests; browser interaction blocked |
| Reduced motion / interruption | System preference, new cue, end session | Preserve semantic eye shapes, limit travel, keep finite effects and safe cleanup | Reduced-travel, semantic-shape, effect lifetime, and session cleanup tests pass; rendered-device review pending |

## Evidence boundaries

Controller and event simulations do not prove the physical microphone, speaker,
or perceived conversational quality. The approved browser previously blocked the
local preview. A fresh read-only browser listing still shows the old unreachable
preview tabs; no alternate browser, host, proxy, or raw connection is used to
bypass that restriction. The user's open preview is not assumed to be inspected.

Provider checks, when run, use synthetic conversation inputs with explicit output
limits. Report actual generated wording and cutoffs, not an inferred success from
the presence of a prompt or a large count of possible combinations.

## Live director contract check, 2026-08-27

Ran `node --import tsx scripts/audit-caption-director.mjs` once: three bounded,
text-only forced-function requests using the production director prompt, parser,
and 800-token ceiling. The provider returned the new compact `intent` field in
all nine cues. No audio was generated by this check.

| Input | Accepted caption lines | Meaning and acting choices | First valid cue |
| --- | --- | --- | --- |
| What's going on on your side? | One complete line, no orphan "side" | Curious/question twice; lean-in + widen, then tilt-right + glance-right | 1203ms |
| I'm so sorry to hear that happened. / That really sucks. / How do you feel about it? | Three complete thoughts | Concerned throughout: comfort + lean-in, emphasize + nod, question + tilt-right | 1154ms |
| I was wrong about that. / Thanks for catching it. / That sounds frustrating, but we can fix it together. | Three complete thoughts | Neutral/correct, neutral/acknowledge, concerned/comfort, determined/reassure | 1773ms |

Caption plans were usable after 658/676/1384ms. Completed responses took
1707/2058/2922ms. Reported usage was 5812 total tokens (5221 input, 591 output),
with zero audio tokens. These are generation/event timings, not device-playback
or perceived reaction latency. In particular, a director can still arrive after
speech starts; local semantic acting must remain coherent while it is pending.

The schema exposes 12 intentions, not the full local animation library. Legacy
cues remain valid; malformed intentions are rejected. Exact gallery variant IDs
are never accepted from provider output. Tests also guard against a mismatched
celebrate/joke role turning vulnerable emotion into celebration or comedy.

A separate single `--reactions` run checked the production recognition tool
with two text-only requests, capped at 224 output tokens each. "I finally got
the job I really wanted!" returned joyful/celebrate with grounded confetti
(first validated cue 896ms). The correction that it was actually a rejection
returned sad/comfort with no effect (792ms). Both completed; reported usage was
2560 total tokens (2461 input, 99 output), zero audio. This verifies provider
choices and the schema, not how those reactions feel in the browser.

## Short-turn provider evidence

The current shared persona targets one 8–20-word ordinary thought and 2–8 words
for acknowledgements/corrections, with longer detail only when explicitly asked.
Its provider-echoed hash is `581725cad79c28de`.

The six-turn text study produced ordinary replies of 5–27 words; the new-topic
case answered the new subject. The explicit-detail study hit its deliberately
small 128-token audit cap, which is not the production 512-token setting.

One separately bounded production-audio check completed two turns: 7.85 seconds
for bad news and 3.80 seconds for a correction, 11.65 seconds total, no cutoff.
The bad-news reply still added an unsolicited offer. This remains a style failure,
not a passed acceptance criterion or a hard length guarantee. Full wording and
stream-only evidence limits are in `conversation-quality-audit.md` and
`persona-text-audit.md`.

## Offline recorded-audio handoff check

`node --import tsx scripts/audit-recorded-handoff.mjs` replays policy input
against the two existing provider WAVs without modifying them or making new API
calls. It measures PCM quiet intervals in 20ms windows (on/off RMS thresholds
0.005/0.0035, 160ms quiet confirmation). The user's overlap is simulated.

For the 2.65-second "What's going on on your side?" recording, a new-topic
overlap starting at 100ms exposed a real policy problem: the first 1.2-second
safety wall began fading at 1312ms while speech was active, well before the final
word. Giving the policy the upcoming thought boundary changed that to:

- 2048ms with the independent approximate word-reference boundary.
- 2240ms with the app's estimated timeline plus measured output silence.

The latter fades during actual PCM silence, with a 140ms fade. A simulated
"yeah" never forces a handoff. Both tested interruptions in the empathy recording
also hand off at measured silence with the estimated timeline (1392ms and 4960ms).

This is stronger timing evidence than an arbitrary event fixture, but it is
still not live microphone/speaker testing. Whisper's approximate word offsets
occasionally label an interval as a word even when the PCM is silent. Neither
those offsets nor the app's timeline provide an exact production word clock.

## Final verification scope

Final local checks on 2026-08-27:

- `npm test -- --maxWorkers=4`: 26 files, 251 tests passing.
- `npm run typecheck`: passing.
- `npm run build`: passing.
- Recorded-PCM handoff probe completed without new provider calls.
- Filename-only credential scan found no project-key marker in application
  source, scripts, documentation, public artifacts, or the production build.

The regression suite covers the expression library, primary-accent ownership,
readable holds, nonrepeating selection, reaction validation, replacing captions,
playback timing, and Realtime lifecycle/turn-taking races. The exhaustive
face/gesture/accent matrix has its own 15-second test timeout because it renders
thousands of combinations and assertions. Frame-to-frame continuity limits are
unchanged; an aggregate test timeout is not a rendering performance budget.

The final lifecycle regression covers a timed-out clear, its late old
acknowledgement, and a second handoff: only the current response's matching clear
can release the queued turn. The global ignore-next-clear flag was removed.
The reaction-release fixture now supplies the response ID on its clear event,
matching the GA event contract rather than accepting an uncorrelated release.

The app remains running on the existing local ports, 5173 and 8787. Start a new
conversation to receive the updated server persona. Neither the generated-output
audits nor passing controller tests establish exact text/voice synchronization,
physical microphone behavior, or that every expression feels convincing. Those
remain explicit in-browser/device acceptance checks, not claimed successes.
