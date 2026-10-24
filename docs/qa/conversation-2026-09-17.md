# Conversation persona pass: 2026-09-17

This pass tightens the shared Realtime persona used by the app. The goal is a
shorter, more natural voice turn while preserving room for an explicit story,
step-by-step explanation, brainstorming request, or substantial help.

## Changes

- Ordinary turns now default to one complete spoken thought, usually 4 to 16
  words.
- Simple facts, recommendations, and why/how questions should answer in one
  sentence, usually 8 to 24 words. A simple recommendation does not become a
  recipe unless the user asks for steps.
- A second sentence needs a reason: a distinct emotional beat or information
  required to make the answer complete.
- Bad news gets one concrete, warm reaction without an automatic offer,
  planning suggestion, question, or therapy-shaped choice.
- New topics take priority immediately. A brief backchannel does not cancel a
  reply, while sustained new speech receives the next turn at a natural
  boundary.
- Detail requests expand in small complete thoughts and yield before extra
  context. The native `perform_character` capability and face/interruption
  instructions remain in the shared session prompt.

## Bounded provider check

One text-only Realtime study used the shared production builder with
`gpt-realtime-2.1`, Cedar, low reasoning, and a 128-token per-response audit
override. It sent six turns and used 353 output tokens in total. No audio call
was made.

The provider echoed the prompt used for the study exactly:

```text
sha256 prefix: 1b709f6004df3da6
```

| Turn | Words | Sentences | Offers | Result |
| --- | ---: | ---: | --- | --- |
| Casual why/how | 29 | 2 | none | Specific answer, but longer than the target |
| Correction | 5 | 2 | none | “Ah, next Thursday. Got it.” |
| Joke | 0 | 0 | none | The text harness saw a face-tool turn and did not acknowledge it |
| Bad news | 11 | 2 | none | Specific empathy, no unsolicited offer |
| New topic | 35 | 2 | none | Direct eggs-and-rice answer, but became a mini-recipe |
| Explicit detail | 73 | 6 | none | Expanded as requested; audit cap ended it mid-answer |

The joke result is a harness limitation, not evidence that the app speaks an
empty reply: the production client acknowledges `perform_character` calls and
continues the response. The 35-word simple recommendation led to the final
prompt tightening; the updated local prompt has hash prefix
`442eb5f90e415b45` and was not sent through a second provider audit in this
bounded pass.

The study is linguistic evidence only. It does not establish voice quality,
microphone behavior, exact word/audio alignment, or human-likeness.

## Verification

```text
npx vitest run server/voice-persona.test.ts   5 passed
npm run typecheck                             passed
```
