import { useEffect, useId, useRef, type RefObject } from "react";
import { renderAvatarExpression } from "@bible-strong/avatar-core";
import { performanceAvatarDefinition } from "../lib/performance-avatar";
import { SpeechPerformance, speakingPortraits, smileEyePath, type VoiceActivity, type FacePerformanceInput } from "../lib/speech-performance";
import type { AvatarExpression, ConversationPhase } from "../types";
import { startFrameLoop } from "../lib/frame-loop";
import type { ReactionCue } from "../lib/reaction-cues";
import { EFFECT_PARTICLE_COUNT, sampleEffect, type EffectParticle } from "../lib/reaction-effects";
import type { CharacterDisplayState } from "../lib/voice-character";

type PerformanceAvatarProps = {
  expression: AvatarExpression;
  phase: ConversationPhase;
  activityRef: RefObject<VoiceActivity>;
  cue?: ReactionCue | null;
  presentationRef?: RefObject<CharacterDisplayState | null>;
  effectPreview?: boolean;
  previewEffect?: FacePerformanceInput["previewEffect"];
};

const particlePaths: Record<EffectParticle["shape"], string> = {
  confetti: "M-3 -7H3Q4 -7 4 -5V5Q4 7 3 7H-3Q-4 7 -4 5V-5Q-4 -7 -3 -7Z",
  sparkle: "M0 -11Q2 -3 11 0Q2 3 0 11Q-2 3 -11 0Q-2 -3 0 -11Z",
  "friendly-mark": "M-13 -2L-21 -10M0 -9V-22M13 -2L21 -10",
  arc: "M-27 5C-20 -18 20 -18 27 5M-18 8C-13 -5 13 -5 18 8",
  question: "M-12 -11C-12 -21 -4 -25 5 -23C15 -21 19 -11 12 -4C7 1 1 2 1 10",
  "question-dot": "M-5.5 27A6.5 6.5 0 1 0 7.5 27A6.5 6.5 0 1 0 -5.5 27Z",
  idea: "M0 -21C-12 -21 -21 -12 -21 0C-21 9 -15 13 -11 17C-9 19 -9 22 -6 22H6C9 22 9 19 11 17C15 13 21 9 21 0C21 -12 12 -21 0 -21ZM-6 26H6C10 26 10 33 6 33H-6C-10 33 -10 26 -6 26Z",
  "idea-ray": "M0 -3V-12",
  "pop-ring": "M0 -15A15 15 0 1 1 0 15A15 15 0 1 1 0 -15Z",
  "pop-ray": "M0 -10V10",
  "laugh-mark": "M-13 -4C-7 6 7 6 13 -4",
  "anger-mark": "M-16 -5Q-5 -5 -5 -16M5 -16Q5 -5 16 -5M16 5Q5 5 5 16M-5 16Q-5 5 -16 5",
};

export function PerformanceAvatar({ expression, phase, activityRef, cue, presentationRef, effectPreview = false, previewEffect }: PerformanceAvatarProps) {
  const clipId = `face-${useId().replaceAll(":", "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const rightRef = useRef<SVGPathElement>(null);
  const characterRef = useRef<SVGGElement>(null);
  const particlesRef = useRef<Array<SVGPathElement | null>>([]);
  const propsRef = useRef({ expression, phase, cue, effectPreview, previewEffect });
  propsRef.current = { expression, phase, cue, effectPreview, previewEffect };
  const initial = useRef(renderAvatarExpression(performanceAvatarDefinition, speakingPortraits[expression]));

  useEffect(() => {
    const controller = new SpeechPerformance(propsRef.current.expression);
    const start = performance.now();
    const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const forceFull = new URLSearchParams(location.search).get("motion") === "full";
    let previousGeometry = "";
    const paint = (now: number) => {
      const sample = controller.sample({
        ...propsRef.current,
        activity: activityRef.current,
        reducedMotion: reducedQuery.matches && !forceFull,
      }, now - start);
      const geometryKey = JSON.stringify([sample.expression, sample.openness, sample.smile]);
      if (geometryKey !== previousGeometry) {
        // Head roll is applied to the body group so the white circle and eyes
        // turn together. The renderer receives a zero roll to avoid rotating
        // the eyes twice; pitch/yaw still shape the projected eye geometry.
        const eyeExpression = { ...sample.expression, headZ: 0 };
        const scene = renderAvatarExpression(performanceAvatarDefinition, eyeExpression, undefined, sample.openness);
        leftRef.current?.setAttribute("d", smileEyePath(scene.geometry.leftPath, sample.smile));
        rightRef.current?.setAttribute("d", smileEyePath(scene.geometry.rightPath, sample.smile));
        previousGeometry = geometryKey;
      }
      if (rootRef.current) {
        rootRef.current.dataset.speechEnergy = sample.energy.toFixed(3);
        rootRef.current.dataset.speechArticulation = sample.speech.toFixed(3);
        rootRef.current.dataset.smile = sample.smile.toFixed(3);
        rootRef.current.dataset.eyeOpenness = sample.openness.toFixed(3);
        rootRef.current.dataset.outputLevel = activityRef.current.output.toFixed(3);
        rootRef.current.dataset.beat = sample.beat;
        rootRef.current.dataset.effect = sample.effect?.kind ?? "none";
        rootRef.current.dataset.cueSource = propsRef.current.cue?.source ?? "none";
        rootRef.current.dataset.cueKind = propsRef.current.cue?.kind ?? "reaction";
        rootRef.current.dataset.phraseIndex = String(propsRef.current.cue?.phraseIndex ?? -1);
        rootRef.current.dataset.gesture = sample.gesture;
        rootRef.current.dataset.headPose = [sample.expression.headX, sample.expression.headY, sample.expression.headZ].map((value) => value.toFixed(2)).join(",");
        rootRef.current.dataset.accent = sample.accent;
        rootRef.current.dataset.variantId = sample.variantId;
        rootRef.current.dataset.intent = sample.intent;
        rootRef.current.dataset.bodyPose = [sample.body.x, sample.body.y, sample.body.scale, sample.body.squashX, sample.body.squashY].map((value) => value.toFixed(3)).join(",");
        rootRef.current.dataset.wordTick = String(sample.wordTick ?? -1);
        rootRef.current.dataset.phraseTick = String(sample.phraseTick ?? -1);
      }
      characterRef.current?.setAttribute(
        "transform",
        `translate(${sample.body.x.toFixed(3)} ${sample.body.y.toFixed(3)}) rotate(${sample.expression.headZ.toFixed(3)}) scale(${(sample.body.scale * sample.body.squashX).toFixed(4)} ${(sample.body.scale * sample.body.squashY).toFixed(4)})`,
      );
      const particles = sampleEffect(sample.effect, now - start, reducedQuery.matches && !forceFull);
      particlesRef.current.forEach((path, index) => {
        if (!path) return;
        const particle = particles[index];
        path.setAttribute("opacity", particle ? particle.opacity.toFixed(3) : "0");
        if (!particle) return;
        path.setAttribute("d", particlePaths[particle.shape]);
        const outline = particle.shape === "arc" || particle.shape === "question" || particle.shape === "idea-ray"
          || particle.shape === "pop-ring" || particle.shape === "pop-ray" || particle.shape === "laugh-mark" || particle.shape === "anger-mark" || particle.shape === "friendly-mark";
        path.setAttribute("fill", outline ? "none" : particle.color);
        path.setAttribute("stroke", outline ? particle.color : "none");
        path.setAttribute("stroke-width", outline ? particle.shape === "question" ? "11.5" : particle.shape === "friendly-mark" ? "8.5" : particle.shape === "anger-mark" ? "5.5" : particle.shape === "idea-ray" ? "5.5" : "3" : "0");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("data-reaction-shape", particle.shape);
        path.setAttribute("transform", `translate(${particle.x.toFixed(2)} ${particle.y.toFixed(2)}) rotate(${particle.rotation.toFixed(2)}) scale(${particle.scale.toFixed(3)})`);
      });
      // Feed back the frame actually painted, not the last requested tool. A
      // ref avoids a React render on every animation frame.
      if (presentationRef) presentationRef.current = {
        expression: propsRef.current.expression,
        phase: propsRef.current.phase,
        gesture: sample.gesture,
        accent: sample.accent,
        intent: sample.intent,
        variantId: sample.variantId,
        effect: particles.some(particle => particle.opacity > 0.05) ? sample.effect?.kind ?? "none" : "none",
        headTiltDegrees: sample.expression.headZ,
        observedAtMs: now,
      };
    };
    const stop = startFrameLoop(paint);
    return () => {
      stop();
      if (presentationRef) presentationRef.current = null;
    };
  }, [activityRef, presentationRef]);

  return (
    <div ref={rootRef} className="performance-avatar" data-performance="context-directed" data-expression={expression} data-phase={phase} data-cue-id={cue?.id} data-cue-anchor={cue?.anchor}>
      <svg className="bs-avatar__svg" viewBox="-150 -150 300 300" role="img" aria-label={`${expression} expressive voice avatar`}>
        <defs><clipPath id={clipId}><path d={initial.current.geometry.headPath} /></clipPath></defs>
        <g ref={characterRef} data-character-body="">
          <path d={initial.current.geometry.headPath} fill="#f4f5f1" />
          <g clipPath={`url(#${clipId})`} fill="#111316">
            <path ref={leftRef} data-eye="left" d={initial.current.geometry.leftPath} stroke="#111316" strokeWidth="1.5" strokeLinejoin="round" />
            <path ref={rightRef} data-eye="right" d={initial.current.geometry.rightPath} stroke="#111316" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
          <g aria-hidden="true" data-reaction-effects="" pointerEvents="none">
            {Array.from({ length: EFFECT_PARTICLE_COUNT }, (_, index) => (
              <path key={index} ref={(element) => { particlesRef.current[index] = element; }} opacity="0" />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
