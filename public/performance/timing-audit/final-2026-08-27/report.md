# Realtime speech timing audit

Generated 2026-08-27T15:14:02.147Z with gpt-realtime-2.1 and cedar.

This is a Node-native provider stream audit. `elapsedMs` is the local arrival time of a WebSocket event; `pcmSamplesCumulative` is audio received so far, converted to an approximate audio offset at 24 kHz. Neither is a perfect playback clock or word timestamp.

## Clips

| Clip | Audio | Realtime transcript | Newlines in instructions → transcript | Audio deltas | Transcript deltas | First transcript (arrival / audio offset) |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| side-question | 2.65s | matches | 4 → 0 | 7 | 8 | 889.9 ms / 0.0 ms |
| empathy-correction | 6.50s | matches | 6 → 2 | 17 | 23 | 1058.8 ms / 0.0 ms |

## What the stream proves

- Every captured audio delta includes its PCM sample count and cumulative sample total.
- Every captured output transcript delta includes local arrival time and the cumulative PCM samples already received when it arrived.
- The response instructions contained line breaks between complete thoughts. The returned audio transcript newline count is recorded per clip; this tells us whether the provider emitted newline characters in transcript deltas, not whether the spoken audio had audible line breaks.
- Whisper word timestamps, when present, are an independent approximate alignment reference over the saved WAV. They are not the Realtime model's own word clock.

## Reproduction

Run `node scripts/audit-speech-timing.mjs --run-id=another-run --skip-whisper` to repeat without the optional transcription pass. The script refuses to overwrite existing audit artifacts and enforces an 18-second clip / 35-second total audio safety limit.

