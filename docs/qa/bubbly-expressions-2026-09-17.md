# Bubbly expressions, 2026-09-17

Direction clarified during implementation: **Animal Crossing-like reaction symbols**, not an anime-styled face. Keep the simple white, two-eye character. No brows, mouth, star pupils or blush. No layout or conversation-length changes in this pass.

## Changed

- Rounder, fuller base eyes and stronger differences between curiosity, surprise, playful, delight and soft concern.
- Continuous happy-crescent deformation, including thickness compression; the tall open eye of a wink stays a capsule.
- Removed the experimental catchlight/blush layer after the user's clarification. Meaning is punctuated through external reaction symbols instead.
- Chunkier rounded question mark with one bouncy entrance. Added a small coral forehead anger mark for comic frustration, never for care/sadness. It is available to the native character tool, validated against compatible feelings, and previewable in the gallery.
- Authored anticipation, squash/stretch and settle on lift, nod and lean-in, without increasing travel bounds or adding a loop.
- Reaction holds now retain the requested semantic silhouette. Explicit reaction gestures, including still, are respected instead of silently replaced with a generic head gesture.

## Verification

- New checks cover continuous outline topology, smile readability, held reaction identity, finite effects and semantic compatibility. Final regression result recorded below.
- TypeScript/build pass; existing >500kB main-chunk advisory remains.
- Operated the Codex preview gallery: amused, delighted, concerned and playful. Inspected intermediate and held frames. Corrected a flat-bottomed open eye noticed in the playful preview.
- Operated recorded celebration and softer-moment scenes. Celebration DOM samples: squash at 0.26s, lift at 0.71s, settle at 1.61s. Concern samples through 1.95s had no decoration. This run preceded removal of the experimental catchlights. These are recorded fixtures, not fresh model/microphone tests or proof of exact voice alignment.
- After clarification, operated Question and Anger in the gallery, verified one-shot symbols and the plain face. Refined anger stroke gaps so its four corners stay separated rather than closing into a star outline.
- Final regression: 44 files / 477 tests pass; typecheck and production build pass. The question mark was brought closer to the head after the transformed drawing-clearance test caught its first position; bounds were not widened.
- Fixed a dev-server stale transform after an incremental edit; reloaded and verified the current renderer before final inspection.

User perceptual acceptance remains open. This pass does not claim human-level emotion accuracy or perfect live voice synchronization.

## Follow-up: friendly, not affectionate

- Replaced the pink heart with three rounded golden greeting rays; the gallery calls it **Friendly** and pairs its default replay with joyful eyes. Kept the face and layout unchanged.
- Kept the legacy `heart` cue key for saved performances, but the renderer contains no heart glyph. Tool guidance describes a friendly thanks/encouragement beat, not romance; current-frame context reports the actual greeting mark.
- In the Codex preview, activated Friendly, inspected the pop, verified it fully faded, and replayed it. No heart particles remained. Drawing-clearance tests caught the initial mark being slightly too high; moved it inward instead of widening bounds.
- Typecheck, production build, and all 478 tests pass. No live provider or microphone calls were made in this follow-up; model adherence to the revised wording remains untested.
