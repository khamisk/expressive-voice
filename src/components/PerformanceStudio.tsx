import { useEffect, useRef, useState } from "react";
import { PerformanceAvatar } from "./PerformanceAvatar";
import { SpokenCaption } from "./SpokenCaption";
import { startFrameLoop } from "../lib/frame-loop";
import type { ReactionCue } from "../lib/reaction-cues";
import type { VoiceActivity } from "../lib/speech-performance";
import type { ConversationPhase, SemanticExpression } from "../types";
import type { CharacterGesture } from "../lib/character-gestures";
import { planCaptionBreaks, speechPunctuation, type SpeechPunctuation } from "../lib/spoken-caption";
import { CAPTION_LEAD_MS, ACTING_LEAD_MS } from "../lib/caption-clock";
import { HeardDelay, VoiceBeatDetector, outputDelayMs, type VoiceBeatState } from "../lib/voice-beats";

type CaptionClock = "recorded-word-timestamps" | "estimated-duration";
type RecordedWord = { word: string; startMs: number; endMs: number };
type RecordedPhrase = { atMs: number; endMs?: number; text: string; expression: SemanticExpression; gesture: CharacterGesture; intensity?: number };
type Scene = {
  id: string;
  title: string;
  prompt: string;
  reply: string;
  expression: SemanticExpression;
  effect: ReactionCue["effect"];
  intensity: number;
  cues?: RecordedPhrase[];
  wordTimestamps?: RecordedWord[];
  captionClock: CaptionClock;
};
type Recording = {
  id: string;
  title?: string;
  prompt?: string;
  transcript: string;
  effect?: ReactionCue["effect"];
  cues?: RecordedPhrase[];
  wordTimestamps?: RecordedWord[];
};

const shortWords = (text: string): string[] => text.trim().split(/\s+/u).filter(Boolean);

const shortScenes: Scene[] = [
  { id: "curious", title: "Curiosity", prompt: "I built a tiny robot that waters my plants.", reply: "Wait, you built that yourself? How did you get it to work?", expression: "curious", effect: "none", intensity: 0.8, captionClock: "estimated-duration" },
  { id: "celebration", title: "A little celebration", prompt: "I finally got the job I wanted.", reply: "You got it! Oh, that is such good news. You earned this.", expression: "excited", effect: "confetti", intensity: 0.94, captionClock: "estimated-duration" },
  { id: "playful", title: "A bit of teasing", prompt: "I definitely didn't eat the last cookie.", reply: "Very convincing. I am almost certain you did not make that up.", expression: "playful", effect: "sparkle", intensity: 0.86, captionClock: "estimated-duration" },
  { id: "gentle", title: "A softer moment", prompt: "It's been a really long day.", reply: "That sounds exhausting. Want to talk about what happened?", expression: "concerned", effect: "none", intensity: 0.8, captionClock: "estimated-duration" },
];

/** Explicitly recorded fixtures; the live conversation never uses these replies. */
export function PerformanceStudio() {
  const [scenes, setScenes] = useState<Scene[]>(shortScenes);
  const [selected, setSelected] = useState(0);
  const [phase, setPhase] = useState<ConversationPhase>("idle");
  const [cue, setCue] = useState<ReactionCue | null>(null);
  const [error, setError] = useState("");
  const [hasPlayed, setHasPlayed] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(-1);
  const [captionText, setCaptionText] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const meterCleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(0);
  const playbackRef = useRef<{ scene: Scene; turnId: string; phraseIndex: number } | null>(null);
  const activityRef = useRef<VoiceActivity>({ input: 0, output: 0 });
  const captionTextRef = useRef("");
  const audioStartedRef = useRef(false);
  const scene = scenes[selected];

  const updateCaption = (next: string) => {
    if (captionTextRef.current === next) return;
    captionTextRef.current = next;
    setCaptionText(next);
  };

  const resetActivity = () => {
    audioStartedRef.current = false;
    activityRef.current.output = 0;
    activityRef.current.wordTick = undefined;
    activityRef.current.phraseTick = undefined;
    activityRef.current.punctuation = undefined;
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/performance/manifest.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Missing recordings");
        return response.json() as Promise<{ recordings: Recording[] }>;
      })
      .then((manifest) => {
        const phraseScenes = manifest.recordings.filter((recording) => recording.cues?.length).map((recording): Scene => ({
          id: recording.id,
          title: recording.title ?? "A longer reply",
          prompt: recording.prompt ?? "Listen to how the reaction changes with each phrase.",
          reply: recording.transcript,
          expression: recording.cues![0].expression,
          intensity: recording.cues![0].intensity ?? 0.85,
          effect: recording.effect ?? "none",
          cues: recording.cues,
          wordTimestamps: recording.wordTimestamps,
          captionClock: recording.wordTimestamps?.length ? "recorded-word-timestamps" : "estimated-duration",
        }));
        const available = [...shortScenes, ...phraseScenes];
        setScenes(available);
        const requested = new URLSearchParams(location.search).get("scene");
        const requestedIndex = available.findIndex((item) => item.id === requested);
        if (requestedIndex >= 0 && sessionRef.current === 0) setSelected(requestedIndex);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setError("The longer recordings couldn't load. Refresh to try again.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    sessionRef.current += 1;
    audioRef.current?.pause();
    playbackRef.current = null;
    meterCleanupRef.current?.();
    void contextRef.current?.close();
  }, []);

  const stop = () => {
    sessionRef.current += 1;
    audioRef.current?.pause();
    playbackRef.current = null;
    resetActivity();
    updateCaption("");
    setPhase("idle");
    setCue(null);
  };

  const updateAudioClock = (audio: HTMLAudioElement, playback: { scene: Scene; turnId: string; phraseIndex: number }, output: number) => {
    if (audio.paused || (!audioStartedRef.current && output <= 0.025)) return;
    audioStartedRef.current = true;
    const timeMs = audio.currentTime * 1000;
    const words = playback.scene.wordTimestamps;
    const scriptWords = shortWords(playback.scene.reply);
    let wordIndex = -1;
    let punctuation: SpeechPunctuation = "none";

    if (words?.length) {
      words.forEach((word, index) => {
        if (word.startMs <= timeMs + CAPTION_LEAD_MS) wordIndex = index;
      });
      if (wordIndex >= 0) punctuation = speechPunctuation(scriptWords[wordIndex] ?? words[wordIndex].word);
    } else {
      // Short legacy fixtures have no Whisper word timestamps. Their caption
      // clock is intentionally explicit: map the current audio duration over
      // the authored words, rather than implying exact alignment.
      const estimatedWords = shortWords(playback.scene.reply);
      const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration * 1000
        : estimatedWords.length * 420;
      wordIndex = Math.min(estimatedWords.length - 1, Math.max(0, Math.floor(((timeMs + CAPTION_LEAD_MS) / durationMs) * estimatedWords.length)));
      if (wordIndex >= 0) punctuation = speechPunctuation(estimatedWords[wordIndex]);
    }

    if (wordIndex < 0) return;
    // Whisper timing tokens omit punctuation. Keep the actual spoken script
    // as the text source so thought boundaries survive in the recorded study.
    const prefix = scriptWords.slice(0, wordIndex + 1).join(" ");
    updateCaption(prefix);

    let nextPhraseIndex = -1;
    if (playback.scene.cues?.length) {
      playback.scene.cues.forEach((phrase, index) => { if (phrase.atMs <= timeMs + ACTING_LEAD_MS) nextPhraseIndex = index; });
    } else {
      let sentenceCount = 0;
      const estimatedWords = shortWords(playback.scene.reply);
      for (let index = 0; index <= wordIndex; index += 1) {
        const mark = speechPunctuation(estimatedWords[index]);
        if (mark === "sentence" || mark === "question" || mark === "exclamation") sentenceCount += 1;
      }
      nextPhraseIndex = Math.max(0, sentenceCount - 1);
    }
    const currentPhrase = playback.scene.cues?.[nextPhraseIndex];
    activityRef.current.wordTick = wordIndex + 1;
    activityRef.current.phraseTick = Math.max(0, nextPhraseIndex);
    activityRef.current.punctuation = punctuation;

    if (nextPhraseIndex >= 0 && nextPhraseIndex !== playback.phraseIndex) {
      playback.phraseIndex = nextPhraseIndex;
      if (!currentPhrase) {
        setPhraseIndex(nextPhraseIndex);
        return;
      }
      setPhraseIndex(nextPhraseIndex);
      setCue({
        id: `${playback.turnId}:phrase:${nextPhraseIndex}`, turnId: playback.turnId, source: "assistant", kind: "speech", phraseIndex: nextPhraseIndex,
        expression: currentPhrase.expression, gesture: currentPhrase.gesture, intensity: currentPhrase.intensity ?? 0.85, confidence: 1,
        effect: nextPhraseIndex === 0 ? playback.scene.effect : "none",
      });
    }
  };

  const play = async (index: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const session = ++sessionRef.current;
    audio.pause();
    playbackRef.current = null;
    resetActivity();
    setSelected(index);
    setHasPlayed(true);
    setError("");
    setPhase("connecting");
    setCue(null);
    setPhraseIndex(-1);
    updateCaption("");
    try {
      if (!contextRef.current) {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.55;
        const source = context.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(context.destination);
        const samples = new Uint8Array(analyser.fftSize);
        // Same syllable path as a live conversation, so recorded studies
        // show the face following the voice exactly as it would live.
        const voiceAnalyser = context.createAnalyser();
        voiceAnalyser.fftSize = 2048;
        voiceAnalyser.smoothingTimeConstant = 0;
        source.connect(voiceAnalyser);
        const voiceSamples = new Float32Array(voiceAnalyser.fftSize);
        const beats = new VoiceBeatDetector();
        const heard = new HeardDelay<VoiceBeatState>({ level: 0, syllableTick: 0, strength: 0, syllableAtMs: null });
        let lastVoiceTime: number | null = null;
        meterCleanupRef.current = startFrameLoop(() => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
          const output = audio.paused ? 0 : Math.min(1, Math.sqrt(sum / samples.length) * 5.5);
          activityRef.current.output = output;
          const fresh = lastVoiceTime === null ? voiceSamples.length : Math.round((context.currentTime - lastVoiceTime) * context.sampleRate);
          lastVoiceTime = context.currentTime;
          if (fresh > 0) {
            voiceAnalyser.getFloatTimeDomainData(voiceSamples);
            const count = Math.min(voiceSamples.length, fresh);
            const now = context.currentTime * 1000;
            const beat = heard.push(beats.push(voiceSamples.subarray(voiceSamples.length - count), context.sampleRate, now), now, Math.max(0, outputDelayMs(context) - 16));
            activityRef.current.syllableTick = beat.syllableTick;
            activityRef.current.syllableStrength = beat.strength;
          }
          const playback = playbackRef.current;
          if (playback) updateAudioClock(audio, playback, output);
        });
        contextRef.current = context;
      }
      await contextRef.current.resume();
      if (session !== sessionRef.current) return;
      const next = scenes[index];
      const turnId = `recorded-${next.id}-${session}`;
      playbackRef.current = { scene: next, turnId, phraseIndex: -1 };
      if (!next.cues) setCue({ id: turnId, turnId, source: "assistant", expression: next.expression, effect: next.effect, intensity: next.intensity, confidence: 1 });
      audio.src = `/performance/${next.id}.wav`;
      await audio.play();
      if (session !== sessionRef.current) return;
      setPhase("speaking");
    } catch {
      if (session !== sessionRef.current) return;
      setError("The recording couldn't play. Try the scene again.");
      setPhase("error");
      setCue(null);
    }
  };

  return (
    <main className="performance-studio">
      <header className="performance-studio__header">
        <div><h1>Character studies</h1><p>Recorded Cedar voice · designed reactions</p></div>
        <a href="/?motion=full">Live conversation <span aria-hidden="true">↗</span></a>
      </header>
      <section className="performance-studio__stage" aria-label="Recorded character performance">
        <p className="performance-studio__prompt">“{scene.prompt}”</p>
        <div className="avatar-frame">
          <PerformanceAvatar expression={phase === "speaking" ? cue?.expression ?? scene.expression : "attentive"} phase={phase} activityRef={activityRef} cue={cue} />
        </div>
        {hasPlayed ? (
          <div data-recorded-phrase={phraseIndex} data-caption-clock={scene.captionClock}>
            <SpokenCaption text={captionText} plan={{ text: scene.reply, breaks: planCaptionBreaks(scene.reply) }} visible={phase === "speaking"} speaking={phase === "speaking"} />
          </div>
        ) : (
          <div className="performance-studio__caption">Choose a scene. Watch the face, then listen to the delivery.</div>
        )}
        <div className="performance-studio__scenes" aria-label="Recorded scenes">
          {scenes.map((item, index) => (
            <button key={item.id} type="button" className={`scene-button ${selected === index ? "scene-button--selected" : ""}`} onClick={() => { void play(index); }} aria-label={`Play ${item.title.toLowerCase()}`}>
              <span className="scene-button__index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <span>{item.title}</span>
              <span className="scene-button__play" aria-hidden="true">{selected === index && phase === "speaking" ? "↻" : "▶"}</span>
            </button>
          ))}
        </div>
        <div className="performance-studio__footer">
          <p>Test recordings · {scene.captionClock === "recorded-word-timestamps" ? "word-timed captions" : "estimated caption timing"}.</p>
          <button className="quiet-button" type="button" onClick={stop} disabled={phase !== "speaking" && phase !== "connecting"}>Stop playback</button>
        </div>
        {error && <p className="connection-error" role="alert">{error}</p>}
        <audio ref={audioRef} onEnded={() => { resetActivity(); playbackRef.current = null; updateCaption(""); setPhase("listening"); setCue(null); }} />
      </section>
    </main>
  );
}
