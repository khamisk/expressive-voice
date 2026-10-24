# Native voice-owned character: implementation and live QA

Session: August 27, 2026. Final checks crossed midnight locally.

## What changed

The main Realtime voice now knows it represents the white character and can use
`perform_character` to choose up to four meaningful beats per reply: expression,
intensity, head gesture, eye accent, a word anchor, and an optional effect. It
does not narrate the controls. Explicit nonverbal requests can produce a face
without speech; asking for a face normally still permits a short spoken reply.

Before a reply, the model receives the latest actual renderer sample, including
the visible variant and head tilt. Stale samples are identified as unavailable.
A tool acknowledgement says **scheduled, not rendered**. This is structured
state feedback, not image/video perception or a claim of sentience.

Native beats own the performance once they become eligible. Local fallback
acting remains available for audio-only replies or unmatched future anchors.
The native path no longer makes separate out-of-band reaction/director requests.
Short recognition holds no longer fall back to neutral just because the next
clause is generic. Existing continuous springs, large eyes, gesture vocabulary,
negative-effect guards, and minimal controls are preserved.

Talk-over distinguishes brief acknowledgements from sustained input. It favors
an available phrase boundary or measured pause, fades the old output, retains
the new input, and tells the next reply to address the latest topic without
resuming unheard material. Sustained native input no longer pays the additional
850 ms auxiliary-transcription grace after committing; brief uncertain input
retains that protection. This is public-API behavior, not ChatGPT's private client.

## Live evidence

These used the real `gpt-realtime-2.1` / Cedar WebRTC connection in the approved
in-app browser. Inputs were typed prompts and existing synthetic speech recordings
injected into the input track. No physical microphone or room acoustics were tested.
The compact event/cue record is in
[native-character-2026-08-27.json](native-character-2026-08-27.json).

| Case | Observed result |
| --- | --- |
| Silent skeptical look and tilt | Native skeptical / tilt-right / squint, about 29 degrees sampled head tilt, no speech and zero sampled output RMS. |
| Surprised face plus one sentence | Native surprised / lift / double-take, followed by exactly one audio continuation: “Oh! That definitely caught me off guard.” Seven words. |
| Ordinary job win | Thirteen-word reply. An intermediate version chose local fallback and lost the delighted hold on its generic follow-up clause; that prompted the continuity fix and clearer native intent guidance. |
| Job win corrected into rejection | Intermediate twelve-word reply, no effect. Its generic second clause exposed the same continuity issue. |
| Recorded brief “yeah” during a story | The voice kept playing. No cancel, no clear, and no extra reply. The full final transcript was separately checked because automated caption sampling missed words while clicking the input control. |
| Recorded substantive correction during celebration | The voice authored delighted, joyful, and proud beats, then concerned and sad beats for the correction. The new reply was fourteen words and did not append an offer. The old audio ended naturally during the recording, so this case alone does not prove forced cancellation. |
| Typed new topic during a volcano explanation | The final run cleared the old output and answered the eggs/rice question directly. The complete twenty-eight-word reply remained captioned and in speaking state through playback. |

The final recorded correction produced:

> I'm sorry. That kind of reversal really stings, especially after hoping for good news.

The final topic redirect produced:

> Fry the rice with a little oil, garlic, and soy sauce, then scramble eggs into it with scallions or any quick veggies for a fast, cozy fried rice.

## Bugs found by the live pass, and fixes

1. An empty provider reply could leave the app thinking indefinitely. It now
   reports an actionable no-reply error instead of hanging. A face request also
   incorrectly became silent in the first prompt version; silence now requires
   an explicit nonverbal request, with separate examples for spoken and silent use.
2. A clear acknowledgement could arrive **before** cancelled `response.done`.
   Retiring the response ID at that first acknowledgement fenced out the later
   completion and stranded the new turn. Generation and playout now retain their
   shared correlation until both are finished. Both event orders have regressions.
3. A fallback RMS silence timer could survive the start of a new real output
   buffer. It changed the UI to listening and froze captions about 900 ms into
   otherwise continuing audio. Real buffer events now cancel the timer; the
   fallback callback also checks connection/response ownership and buffer state.
4. Native response reservations now require the expected request metadata echo.
   Delayed old output, duplicate creation events, stale tool calls, and mixed
   audio/tool completions cannot take over the current reply.

The final live redirect reproduced the originally failing event order:

| Event | Milliseconds from initial response request |
| --- | ---: |
| Cancel + output clear sent | 3,494 |
| Matching clear acknowledged | 3,542 |
| Cancelled generation completed | 3,574 |
| New-topic response requested | 3,574 |
| New-topic audio buffer started | 4,230 |
| New-topic output finished | 13,121 |

The new request was issued as soon as cancellation settled, and its buffer
started 656 ms later. These are event timings, not acoustic word alignment.

## Verification and limits

- Final regression: **441 tests / 40 files passed**. TypeScript and production
  build passed. Vite reports a non-blocking 503.07 kB main-chunk warning.
- The native lifecycle suite includes 22 cases: tool-only continuation, silent
  requests, mixed audio/tool output, stale IDs, overlap, both clear/done orders,
  missing ASR, sustained-input timing, and stale silence timers.
- Screenshots and rendered diagnostics were inspected for skeptical tilt,
  surprise, celebration, concern, and the unchanged normal interface. The final
  browser error log was empty. The live test was ended and the normal preview
  restored without QA controls.
- The UI skill guided continuous state changes and rendered verification; no
  extra main-screen controls or interface redesign were introduced.
- Native tool selection is optional. It was observed for direct face requests
  and the final good-news/correction sequence, but factual replies can still use
  local acting. This is not evidence that every feeling is consistently chosen.
- A tool-only plan needs an acknowledgement and an additional audio generation
  round trip. In the surprise case, the first request to audio-buffer start was
  about 1.65 seconds. This tradeoff remains; native control is not free latency.
- The sustained-input ASR-grace optimization is covered locally; the recorded
  correction predates that final optimization. The final typed redirect used
  the latest production code.
- Captions and anchored beats share an estimated playback timeline. The Realtime
  stream does not provide word-level playback timestamps, so exact voice/text/
  facial synchronization is **not** claimed. Native mode uses transcript
  sentence/newline boundaries and the existing linguistic caption planner.
- Physical-microphone overlap, echo cancellation, perceived speaker delivery,
  and a label-hidden human quality review are still required. Unit tests and
  sampled RMS are not proof of natural conversation or human-quality animation.

## Next acceptance pass

Use headphones and a real microphone: a brief “yeah,” a sustained correction,
a genuinely different topic, a silent expression request, and a direct question
about the current face. Judge the transition and timing with labels hidden.
Then tune the native tool's latency and phrase anchors from those recordings;
adding more face combinations is not a substitute for that check.
