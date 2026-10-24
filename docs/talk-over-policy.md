# Talk-over policy

`src/lib/turn-taking.ts` is the transport-independent policy for a natural
voice handoff. It deliberately does not pretend to reproduce the private
ChatGPT client. The caller feeds it the public signals that the app can
observe, then owns the Realtime events and audio element.

## Policy contract

Call `TalkOverController.update(snapshot)` with:

- `userSpeechActive` from VAD and, while an overlap is pending, the local input
  meter in `inputLevel`;
- the cumulative streaming or completed `userTranscript`;
- `userPaused` when a VAD/semantic stop is observed;
- `outputQuiet` only after the currently playing assistant audio has been quiet
  for a short measured interval (roughly 160 ms);
- `assistantGenerating` and `assistantAudioPlaying` separately; and
- an optional assistant `outputBoundary` of `phrase` or `sentence`, plus
  `outputBoundaryAt`, the next estimated phrase ending on the playback clock.

The controller ignores a short backchannel (`yeah`, `mhm`, `uh-huh`, and so on),
even if VAD reports a stop. A completed, quiet backchannel has no latent safety
timer; the bounded fallback is reserved for input that is still genuinely
sustained. It treats a transcript-backed correction as substantive, then waits
for a safe output phrase/sentence boundary or measured output quiet rather than
cutting as soon as the microphone activates. After the 420ms minimum overlap,
nearby known phrase endings and measured output silence have priority. An initial
1.2s fallback can extend to a known nearby boundary with up to 2s of grace,
bounded from the original overlap deadline (not a sliding window); it must
not cut an audible short thought just because that wall was reached. Unknown or
unreliable timing still requires an emergency deadline rather than allowing the
old topic to continue indefinitely. Natural handoffs use a 140ms fade, emergency
fallbacks 180ms. These are policy/transition estimates, not word-perfect audio
guarantees. The recorded-PCM probe in `meaning-variation-validation.md` caught and
verified the short-question boundary case.

An explicit transcript beginning with `stop`, `hold on`, `hang on`, or a clearly
time-seeking form such as `wait a second` becomes `stop_intent` and can override
the normal minimum/boundary wait. Ordinary corrections such as `no, that is
wrong` do not.

The root transport should call `reset()` when the conversation ends and when a
new assistant response starts after an overlap has been resolved. A caller
that uses `nextCheckAt` should poll with the latest input/output snapshot, not a
stale copy captured when VAD first fired.

## Public Realtime semantics verified

The behavior below is from the official OpenAI Realtime API references:

- Semantic VAD has `interrupt_response` and `create_response` controls. With
  `interrupt_response: false`, VAD start does not automatically cancel an
  ongoing default-conversation response. With both controls false, VAD events
  still arrive but automatic responses are disabled. Semantic VAD can wait for
  a more natural turn end, at the cost of additional latency.
- `response.cancel` stops an in-progress response and produces a cancelled
  `response.done`. Calling it when no response is active is safe for the
  session but produces an error event, so the integration should gate it on
  `responseActive`.
- For WebRTC/SIP, the server manages the output buffer and knows how much audio
  has played. `output_audio_buffer.clear` cuts unplayed output, emits
  `output_audio_buffer.cleared`, and truncates the conversation automatically.
  The API reference says to send `response.cancel` first when stopping
  generation.
- Manual `conversation.item.truncate` with an assistant item id, content index,
  and played `audio_end_ms` is the WebSocket path, where the client owns audio
  playback. This app uses WebRTC, so it must not invent an inaccurate playback
  duration or send that manual truncation event.

References:

- [Realtime client events](https://platform.openai.com/docs/api-reference/realtime-client-events)
- [Realtime API reference](https://platform.openai.com/docs/api-reference/realtime)
- [Realtime server events: conversation item truncated](https://platform.openai.com/docs/api-reference/realtime-server-events/conversation/item/truncated)

## Integration sequence

1. Keep server-side `interrupt_response: false` so the fixed 650 ms VAD
   cancellation path cannot race this policy.
2. On speech start and transcript deltas, update the controller with the
   current snapshot. Preserve the user transcript even if the assistant is
   still speaking.
3. On a completed input transcript plus quiet VAD, call `update` with
   `userPaused: true`. Do not hand off solely on that user pause: wait for an
   authored assistant phrase/sentence boundary or set `outputQuiet: true` only
   after measured output silence (roughly 160 ms). If it returns a handoff,
   cancel generation first and clear the output buffer second. Only clear local
   captions for audio that was not heard.
4. On authored assistant phrase boundaries, pass `outputBoundary: "phrase"`
   or `"sentence"`; do not promote every word into a handoff boundary. Provide
   upcoming punctuation deadlines from the timeline before the punctuation word
   itself becomes visible, so the policy can wait for a short coherent ending.
5. On output stop, clear, response completion, close, or a new response, feed
   the new state and reset at the lifecycle boundary. Repeated server events
   must not send repeated cancel/clear events.

Generation completion is not playback completion. Keep the active response ID
through `response.done` until its id-bearing output-buffer stop/clear arrives.
Fence stale output events and match clear acknowledgements to the response whose
buffer was cleared; an old response must not end a newly started reply. If the
clear acknowledgement is missing, a bounded fallback releases the queued turn.
Clear acknowledgements with a missing ID cannot release a pending clear whose
response ID is known. Late timed-out acknowledgements are fenced by retired
response IDs, not by a global ignore-next-event flag that could affect a later
handoff.

Input item IDs also fence delayed VAD stops and ASR events. Once the provider has
committed the new audio, auxiliary transcription is not required to release the
next voice response: failed or missing ASR uses a bounded handoff without
inventing transcript-backed reactions. If the old response is generating but
has not started audio, substantive input can yield after the short overlap floor
because there is no audible word to protect. Neither policy claims access to
the private ChatGPT voice client's behavior.

The unit tests cover short acknowledgements, completed quiet acknowledgements
with long-running assistant audio, noisy starts, delayed VAD stop, substantive
corrections, missing transcripts, phrase boundaries, output quiet gaps,
generation finishing before buffered audio, repeated boundaries, explicit stop
intent, explicit button stop, and reset. They do not replace a physical
microphone test with audible speakers; that remains device-dependent QA.
