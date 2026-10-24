# Conversation quality audit

This is a bounded provider-stream study for the voice persona. It used the shared session builder from `server/voice-persona.ts`, GPT-Realtime-2.1, Cedar, low reasoning, semantic VAD, and the production 512-token cap. It sent text conversation items and captured returned audio/transcript events through a Node WebSocket. It did not use a browser, microphone, speaker, or saved audio.

The first attempt was stopped after the baseline factual response reported `status: incomplete` and the revised factual response crossed the 18-second safety limit. The script did not persist a PCM duration for that failed attempt, so its audio usage is unknown. A second attempt captured 40.40 seconds of audio before the revised factual turn crossed the same safety limit. Therefore 40.40 seconds is a measured lower bound for those earlier attempts, not the total across attempts. A later two-turn short-current audio stream is documented below; none of these runs is a perceptual browser, microphone, or speaker test.

## Captured turns

| Phase / turn | Result | Audio | Response time | First transcript / first audio | Transcript deltas |
| --- | --- | ---: | ---: | --- | ---: |
| Baseline / factual | completed | 15.70s | 4025ms | 571ms / 832ms | 57 |
| Baseline / correction | completed | 6.30s | 2144ms | 524ms / 785ms | 23 |
| Revised / factual | safety cutoff at 18s | 18.40s captured | 5108ms | 515ms / 802ms | 76 |

The provider transcript for the baseline factual turn was:

> That lovely smell is chemistry doing a happy little dance.
>
> As bread heats up, sugars and amino acids react.
>
> This browning, called the Maillard reaction, makes new flavor compounds.
>
> Some of those are aromatic, so your nose gets warm, nutty, slightly sweet notes.

The baseline correction turn was:

> Ah, got it. Next Thursday it is. No worries. That kind of mix-up happens all the time.

The revised factual turn was still speaking when the safety cutoff stopped capture:

> It’s mostly the Maillard reaction, which is a fancy name for what happens when heat makes sugars and proteins team up and create new flavor and aroma compounds. Then you also get a bit of caramelization, where sugars break down and turn sweet, nutty, and toasty. Your nose picks up those warm, complex notes super fast, which is why it smells so ridiculously

These examples are evidence about the captured stream, not a human-likeness score. The baseline example is overly cute for a simple factual question, and its correction contains generic reassurance. The revised example is more specific, but it is too long and ends mid-thought under the safety cap. The production prompt now explicitly treats casual why/how questions as short turns and permits longer answers only for an explicit request for detail, a step-by-step explanation, a story, or substantial help.

Transcript deltas arrived before the first audio delta in all captured turns. That is useful stream-order evidence, but it is not a playback-clock or word-level synchronization measurement.

## Reproduction

```text
npx tsx scripts/audit-conversation-quality.ts
```

The script enforces a 20-second request timeout, an 18-second turn limit, and a 45-second total-audio limit. It never prints the API key or authorization header. It reports generated transcripts and provider usage only when a response completes; it does not manufacture expected replies or an automatic conversational-quality score.

## Acceptance bar for the next real run

- A casual factual or why/how turn answers in one or two natural sentences and stops cleanly.
- A correction uses the corrected fact without a stock reassurance loop.
- A joke gets a light, proportionate reaction without forced laughter or slang.
- Bad news gets a specific, gentle response without a cheery question or instant optimism.
- Simple turns begin quickly and do not hit the 18-second safety boundary.

## Later short-thought check

The later prompt pass was evaluated once with a six-turn text-only study. Its session echo matched the configured prompt (`581725cad79c28de`), but the study is not an audio validation. Ordinary turns were 5 to 27 words. The bad-news turn still appended an unsolicited offer, and the explicit-detail turn reached the 128-token text-audit cap mid-explanation. No audio was generated in that text-only study. A subsequent, separately bounded production-audio check is recorded below. The earlier attempts' accounting is unchanged: the first attempt's duration was not persisted, while the second measured 40.40 seconds.

## Short-current production audio check

After the short-thought persona pass, `--short-current` ran one fresh provider WebSocket using the exact shared production session builder, final prompt, Cedar, low reasoning, semantic VAD configuration, and production 512-token cap. It did not enter the baseline/revised loop. The session echo matched exactly: sent and echoed prompt hash `581725cad79c28de`. The branch allows at most two turns, stops at 10 seconds per turn or 16 seconds total, and was not retried.

| Turn | Status | Complete transcript | Captured audio | Response time | First transcript / first audio | Usage |
| --- | --- | --- | ---: | ---: | --- | --- |
| Bad news | completed | “Oof. That’s rough, especially after you felt good about it. If you want, we can unpack it or just sit with the sting for a minute.” | 7.85s | 2206ms | 430ms / 672ms | 880 total, 219 output (157 audio, 62 text) |
| Correction | completed | “Ah, next Thursday, not tomorrow. Got it.” | 3.80s | 1239ms | 373ms / 590ms | 831 total, 110 output (76 audio, 34 text) |

Total captured audio was 11.65 seconds. Both turns stayed below the 10-second per-turn and 16-second total limits; neither was safety-cut off. The bad-news response is still linguistically too eager to offer emotional processing, which matches the text-only finding. The correction is short and grounded. Transcript deltas arrived before the first audio delta in both turns, so these timestamps describe provider event order and received PCM, not actual playback synchronization or perceived naturalness. This check used no browser, microphone, or speaker and makes no claim about what a person would hear.

Reproduce only this bounded branch with:

```text
npx tsx scripts/audit-conversation-quality.ts --short-current
```
