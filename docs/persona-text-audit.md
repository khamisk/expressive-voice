# Persona text audit

This report covers three bounded, text-only Realtime studies: an initial four-turn run, a two-turn follow-up, and a final four-turn check. Each used the production persona at that point and the shared session builder, GPT-Realtime-2.1, Cedar, low reasoning, and a 160-token per-response text override. Each study preserved context within its own WebSocket session. The text modality was intentional: these results describe wording and turn shape, not voice cadence, audio playback, browser behavior, microphone behavior, or speaker output.

## Initial captured run

| Turn | Words | Sentences | Questions | Canned reassurance patterns | Response time |
| --- | ---: | ---: | --- | ---: | ---: |
| Casual why/how | 35 | 2 | 0 | none | 887ms |
| Correction | 34 | 2 | 0 | none | 1059ms |
| Small joke | 36 | 3 | 0 | none | 859ms |
| Bad news | 52 | 3 | 0 | none | 928ms |

The captured wording was:

1. “That lovely smell is mostly the Maillard reaction: proteins and sugars in the bread react as it heats, creating a bunch of flavorful aroma compounds. A bit of sugar caramelization adds sweet, toasty notes too.”
2. “Got it, thanks for the correction: it’s next Thursday, not tomorrow. If you want, I can help you plan a quick reminder or a simple prep list so it doesn’t sneak up on you.”
3. “Ha, that’s perfect. Your code heard ‘break’ and immediately filed paperwork. If it’s opening issues on its own, maybe it’s time for a truce: a short walk, then a fresh look at whatever it’s complaining about.”
4. “Oof, that’s a really tough moment, especially after a final round when you felt good about it. It’s a weird mix of disappointment and confusion. If you’d like, paste the email (or the gist), and I can help you draft a short, professional reply asking for feedback and keeping the door open.”

The wording is more grounded than the earlier audio control, and the correction preserves the new date. The concrete weakness is unsolicited follow-up planning: both the correction and bad-news replies append an offer even though the user did not ask for advice. The production persona was tightened once after this run to say that an ordinary update or bad news should be answered briefly first and should not automatically receive a plan, offer, or question. The factual rule was also tightened to lead with the answer instead of a cute metaphor or mini-lesson. Those changes were subsequently checked by the two-turn follow-up below, before the final compact-persona revision.

The provider reported 307 output tokens across the four text responses. No dollar estimate is inferred from this study. Descriptive counts above are not an automatic human-likeness score.

## Reproduction

```text
npx tsx scripts/audit-persona-text.ts
```

The script uses the shared production instructions and config, never prints credentials, and stops after four responses or a 20-second per-response timeout.
Use `--follow-up` to select only the correction and bad-news turns. That captured
two-turn follow-up used 133 output tokens; the initial and final runs used 307 and
196 respectively. Counts describe provider reports, not inferred billing.

## Final compact-persona check

After the first run, the persona was reduced to a positive guide with four short examples rather than a long list of prohibitions. The examples cover a plain correction, brief specific empathy, a direct factual answer, and a question that is earned by good news. A two-turn follow-up immediately before this change still produced a correction with an em dash and an unsolicited offer after bad news, so the final check tested those failure modes again.

That follow-up generated:

> “Got it, thanks for the correction. Next Thursday it is, not tomorrow. Nice catch—better to spot it now than scramble later.”
>
> “Oof, that’s tough, especially after a final round when you felt it went well. I’m sorry you got that news. If you want, I can help you draft a short reply asking for feedback, or we can just sit with it for a moment.”

The final four-turn text-only run verified the session echo before sending any conversation items:

```text
session instructions exact: true
sent sha256: 0c00030f0f6c8599
echoed sha256: 0c00030f0f6c8599
```

| Turn | Words | Sentences | Questions | Canned reassurance | Correction grounded | Response time |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| Casual why/how | 29 | 2 | 0 | none | n/a | 758ms |
| Correction | 5 | 2 | 0 | none | yes | 451ms |
| Small joke | 24 | 3 | 0 | none | n/a | 648ms |
| Bad news | 43 | 4 | 0 | none | n/a | 885ms |

The final generated turns were:

1. “Heat triggers the Maillard reaction, where proteins and sugars rearrange and form lots of flavorful, aromatic compounds. That creates those rich, nutty, slightly sweet ‘toasty’ smells your brain loves.”
2. “Ah, next Thursday. Got it.”
3. “Ha, that’s pretty on brand. Your code heard ‘take a break’ and filed paperwork instead. Sounds like it’s ready for a project manager hat.”
4. “Oof. That’s rough, especially after feeling good about the final round. It can feel like the floor shifts under you a bit. If you want, I can help you draft a reply asking for feedback, or just sit with it for a minute.”

This is a meaningful improvement for short factual and correction turns: the correction is five words, preserves the corrected date, has no em dash, and arrives in 451ms. The joke is specific and compact. The bad-news turn is still a partial failure: it is specific and avoids canned reassurance, but it adds an offer and a “sit with it” therapy-shaped choice despite the user not asking for help. That behavior remains an explicit follow-up item rather than being hidden by a pass/fail score. No further provider calls were made after this final check.

The provider reported 196 output tokens across the four final text responses. This does not establish voice cadence, audio synchronization, or microphone/browser behavior, and it is not an automatic human-likeness score.

## Short-thought policy check

The next production-persona pass made the default turn explicitly short: one spoken thought, usually 8 to 20 words; acknowledgements and corrections can be 2 to 8 words; longer replies are reserved for an explicit detail, story, step-by-step, or substantial-help request. It also added a newest-topic rule so a redirect drops the earlier thread instead of finishing or recapping it. The current local prompt is 2,886 characters with SHA-256 prefix `581725cad79c28de`.

One final six-turn text-only run verified that the provider echoed the exact configured prompt before any turns were sent:

```text
session instructions exact: true
sent sha256: 581725cad79c28de
echoed sha256: 581725cad79c28de
```

| Turn | Words | Sentences | Questions | Offer markers | Em dashes | Grounding |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Casual why/how | 24 | 2 | 0 | none | 0 | n/a |
| Correction | 5 | 2 | 0 | none | 0 | corrected date |
| Small joke | 14 | 2 | 0 | none | 0 | n/a |
| Bad news | 24 | 2 | 0 | `if you want/like` | 0 | specific empathy |
| New-topic redirect | 27 | 1 | 0 | none | 0 | eggs/rice/dinner |
| Explicit detail | 77 | 4 | 0 | none | 0 | status incomplete at 128-token cap |

Generated examples included:

- Correction: “Ah, next Thursday. Got it.”
- Joke: “Ha, your code took that literally and filed a complaint. I respect the initiative.”
- New topic: “Do a fast egg fried rice: cook or reheat rice, scramble eggs, then toss together with soy sauce, a bit of oil, and any veggies you’ve got.”
- Bad news: “Oof, that stings, especially after feeling good about the final round. If you want to talk it through or draft a reply, I’m here.”

The short-turn shape now behaves much closer to the intended conversation: 5 to 27 words for ordinary turns, no em dashes, no canned reassurance, and a direct newest-topic answer. Two limitations remain visible. The bad-news response still appends an offer even though the user did not ask for help, and the explicit-detail response correctly expands but is cut off by the deliberately short 128-token text-audit cap. A later two-turn production-audio check is recorded in `conversation-quality-audit.md`; it confirms the audio stream stayed within its safety limits but repeats the bad-news offer. The text result is linguistic evidence only, not a voice-cadence, audio-synchronization, browser, microphone, or speaker test.

The provider reported 341 output tokens across these six text responses. This is a provider usage count, not an inferred dollar cost.
