import { useEffect, useRef, useState } from "react";
import { PerformanceAvatar } from "./components/PerformanceAvatar";
import { SpokenCaption } from "./components/SpokenCaption";
import { expressionForPhase } from "./lib/expressions";
import { SherpaEmbedBridge } from "./lib/embed-bridge";
import { RealtimeVoiceClient, type VoiceGrounding, type VoiceSource } from "./lib/realtime";
import type { ReactionCue } from "./lib/reaction-cues";
import type { CaptionPlan } from "./lib/spoken-caption";
import type { VoiceActivity } from "./lib/speech-performance";
import type { CharacterDisplayState } from "./lib/voice-character";
import type { ConversationPhase, SemanticExpression } from "./types";

const phaseCopy: Record<ConversationPhase, string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Checking the documents",
  speaking: "Speaking",
  error: "Voice stopped",
};

function sourceLabel(source: VoiceSource): string {
  const title = source.title?.trim();
  if (title) return title;
  return "Open source";
}

export function SherpaEmbedApp() {
  const bridgeRef = useRef<SherpaEmbedBridge | null>(null);
  const clientRef = useRef<RealtimeVoiceClient | null>(null);
  const activityRef = useRef<VoiceActivity>({ input: 0, output: 0, wordTick: 0, phraseTick: 0, punctuation: "none" });
  const presentationRef = useRef<CharacterDisplayState | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [phase, setPhase] = useState<ConversationPhase>("idle");
  const [semanticExpression, setSemanticExpression] = useState<SemanticExpression>("neutral");
  const [captionPlan, setCaptionPlan] = useState<CaptionPlan | undefined>();
  const [reactionCue, setReactionCue] = useState<ReactionCue | null>(null);
  const [transcript, setTranscript] = useState("");
  const [sources, setSources] = useState<VoiceSource[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const phaseRef = useRef<ConversationPhase>("idle");
  const transcriptRef = useRef("");
  const sourcesRef = useRef<VoiceSource[]>([]);
  const errorRef = useRef<string | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retainedUserCueRef = useRef<ReactionCue | null>(null);
  const turnCompleteRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const outputPeakRef = useRef(0);
  const qaAudioRef = useRef<AudioContext | null>(null);
  const qaInputRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const heardUserRef = useRef("");
  const qaEnabled = window.__MOOD_VOICE_EMBED_CONFIG__?.qa === true;

  const closeQaAudio = () => {
    void qaAudioRef.current?.close();
    qaAudioRef.current = null;
    qaInputRef.current = null;
  };

  const clearSettling = () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  };

  const updatePhase = (nextPhase: ConversationPhase) => {
    const previousPhase = phaseRef.current;
    if (nextPhase === previousPhase) return;
    clearSettling();
    if (nextPhase === "thinking") {
      const recognized = retainedUserCueRef.current;
      setSemanticExpression(recognized?.expression ?? "neutral");
      setReactionCue(recognized);
    }
    if (nextPhase === "listening" && (previousPhase === "speaking" || previousPhase === "thinking")) {
      const faceOnlyReply = previousPhase === "thinking"
        && retainedUserCueRef.current?.id.startsWith("voice-character:");
      settleTimerRef.current = setTimeout(() => {
        retainedUserCueRef.current = null;
        setSemanticExpression("neutral");
        setReactionCue(null);
      }, faceOnlyReply ? 2_400 : 900);
    } else if (nextPhase === "idle" || nextPhase === "error") {
      retainedUserCueRef.current = null;
      setSemanticExpression("neutral");
      setReactionCue(null);
    }
    if (nextPhase === "error") turnCompleteRef.current = false;
    if (nextPhase === "listening" && previousPhase === "connecting") sessionReadyRef.current = true;
    if (nextPhase === "listening" && (previousPhase === "speaking" || previousPhase === "thinking") && transcriptRef.current.trim()) {
      turnCompleteRef.current = true;
    }
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  };

  useEffect(() => {
    const bridge = new SherpaEmbedBridge();
    bridgeRef.current = bridge;
    bridge.setStopHandler(() => {
      clientRef.current?.close();
      clientRef.current = null;
      closeQaAudio();
      clearSettling();
      setMuted(false);
      sessionReadyRef.current = false;
      turnCompleteRef.current = false;
      outputPeakRef.current = 0;
      transcriptRef.current = "";
      sourcesRef.current = [];
      setTranscript("");
      setSources([]);
      setSourcesOpen(false);
      setCaptionPlan(undefined);
      updatePhase("idle");
    });
    void bridge.waitUntilReady()
      .then(() => setBridgeReady(true))
      .catch(() => undefined);
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
      closeQaAudio();
      clearSettling();
      if (qaEnabled) delete window.__sherpaVoiceQa;
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [qaEnabled]);

  useEffect(() => {
    if (!qaEnabled) return;
    window.__sherpaVoiceQa = {
      get ready() { return sessionReadyRef.current; },
      get turnComplete() { return turnCompleteRef.current; },
      sendTextTurn: (text: string) => {
        if (!sessionReadyRef.current || !clientRef.current || !text.trim()) return false;
        turnCompleteRef.current = false;
        outputPeakRef.current = 0;
        clientRef.current.sendTextTurn(text);
        return true;
      },
      snapshot: () => ({
        ready: sessionReadyRef.current,
        turnComplete: turnCompleteRef.current,
        phase: phaseRef.current,
        transcript: transcriptRef.current,
        sources: sourcesRef.current,
        error: errorRef.current,
        outputPeak: outputPeakRef.current,
        heardUser: heardUserRef.current,
      }),
      sendAudioTurn: async (encoded: string) => {
        const context = qaAudioRef.current;
        const destination = qaInputRef.current;
        if (!sessionReadyRef.current || !context || !destination) return false;
        turnCompleteRef.current = false;
        outputPeakRef.current = 0;
        heardUserRef.current = "";
        const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
        const buffer = await context.decodeAudioData(bytes.buffer);
        await context.resume();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.start();
        return true;
      },
    };
    return () => { delete window.__sherpaVoiceQa; };
  }, [qaEnabled]);

  const resetConversationState = () => {
    clearSettling();
    setMuted(false);
    sessionReadyRef.current = false;
    turnCompleteRef.current = false;
    outputPeakRef.current = 0;
    transcriptRef.current = "";
    sourcesRef.current = [];
    setTranscript("");
    setSources([]);
    setSourcesOpen(false);
    setCaptionPlan(undefined);
    setSemanticExpression("neutral");
    setReactionCue(null);
    retainedUserCueRef.current = null;
    heardUserRef.current = "";
  };

  const endConversation = () => {
    clientRef.current?.close();
    clientRef.current = null;
    closeQaAudio();
    resetConversationState();
    updatePhase("idle");
    void bridgeRef.current?.closeRemote().catch(() => undefined);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        endConversation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const startConversation = async () => {
    const bridge = bridgeRef.current;
    if (!bridge || phase === "connecting" || phase === "listening" || phase === "thinking" || phase === "speaking") return;
    setError(null);
    errorRef.current = null;
    resetConversationState();
    updatePhase("connecting");
    try {
      await bridge.waitUntilReady();
      const client = new RealtimeVoiceClient({
        getCharacterState: () => presentationRef.current,
        onPhase: updatePhase,
        onTranscriptReset: () => {
          transcriptRef.current = "";
          activityRef.current.wordTick = 0;
          activityRef.current.phraseTick = 0;
          activityRef.current.punctuation = "none";
          setTranscript("");
          setCaptionPlan(undefined);
        },
        onTranscriptDelta: (delta) => {
          transcriptRef.current += delta;
          setTranscript(transcriptRef.current);
        },
        onUserTranscriptReset: () => { heardUserRef.current = ""; },
        onUserTranscriptDelta: (delta) => { heardUserRef.current += delta; },
        onCaptionPlan: setCaptionPlan,
        onReactionCue: (cue) => {
          clearSettling();
          retainedUserCueRef.current = cue.source === "user" ? cue : null;
          setSemanticExpression(cue.expression);
          setReactionCue(cue);
        },
        onAmplitude: (source, amplitude) => {
          activityRef.current[source] = amplitude;
          if (source === "output") outputPeakRef.current = Math.max(outputPeakRef.current, amplitude);
        },
        onPlaybackWord: ({ wordTick, phraseTick, punctuation }) => {
          Object.assign(activityRef.current, { wordTick, phraseTick, punctuation });
        },
        onGrounding: (grounding: VoiceGrounding | null) => {
          sourcesRef.current = grounding?.sources ?? [];
          setSourcesOpen(false);
          setSources(sourcesRef.current);
        },
        onError: (message) => {
          sourcesRef.current = [];
          setSources([]);
          setSourcesOpen(false);
          errorRef.current = message;
          setError(message);
        },
      }, {
        transport: bridge,
        grounding: (request) => bridge.search(request),
      });
      clientRef.current = client;
      if (qaEnabled) {
        closeQaAudio();
        qaAudioRef.current = new AudioContext();
        qaInputRef.current = qaAudioRef.current.createMediaStreamDestination();
        await qaAudioRef.current.resume();
        await client.connect({ inputStream: qaInputRef.current.stream });
      } else {
        await client.connect();
      }
    } catch (failure) {
      clientRef.current = null;
      closeQaAudio();
      sessionReadyRef.current = false;
      turnCompleteRef.current = false;
      const message = failure instanceof Error ? failure.message : "The SHERPA voice service could not start.";
      errorRef.current = message;
      setError(message);
      updatePhase("error");
    }
  };

  const toggleMute = () => {
    const client = clientRef.current;
    if (!client || phase === "idle" || phase === "error" || phase === "connecting") return;
    const next = !muted;
    client.setMicrophoneMuted(next);
    setMuted(next);
  };

  const active = phase !== "idle" && phase !== "error";
  const primaryLabel = phase === "connecting" ? "Connecting" : active ? "End conversation" : "Start conversation";
  const effectiveExpression = expressionForPhase(phase, semanticExpression);

  return (
    <main className="voice-embed" aria-label="SHERPA voice assistant">
      <section className="voice-embed__stage" aria-live="polite">
        <div className="voice-embed__avatar-frame" aria-label="SHERPA voice avatar">
          <PerformanceAvatar
            expression={effectiveExpression}
            phase={phase}
            activityRef={activityRef}
            presentationRef={presentationRef}
            cue={reactionCue}
          />
        </div>
        <SpokenCaption text={transcript} plan={captionPlan} visible={Boolean(transcript)} speaking={phase === "speaking"} />
      </section>

      {sources.length > 0 ? (
        <div className="voice-embed__sources">
          <button
            type="button"
            className="voice-embed__sources-trigger"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((open) => !open)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 13h8M8 17h6" /></svg>
            Sources · {sources.length}
          </button>
          {sourcesOpen ? (
            <div className="voice-embed__sources-popover" role="dialog" aria-label="Sources used">
              {sources.slice(0, 4).map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="voice-embed__source"
                  onClick={() => void bridgeRef.current?.openSource(source.id, source.excerpt).catch(() => setError("That source could not be opened."))}
                >
                  <span>{sourceLabel(source)}</span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="voice-embed__controls">
        <span className={`voice-embed__phase voice-embed__phase--${phase}`} aria-live="polite">
          {bridgeReady ? phaseCopy[phase] : "Connecting to workspace"}
        </span>
        <button type="button" className={`voice-embed__primary ${active ? "voice-embed__primary--active" : ""}`} onClick={() => (active ? endConversation() : void startConversation())} disabled={!bridgeReady || phase === "connecting"}>
          <svg className="voice-embed__primary-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">{active ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> : <path d="M4 9v6m4-10v14m4-11v8m4-13v18m4-12v6" />}</svg>
          {primaryLabel}
        </button>
        {active ? (
          <button type="button" className="voice-embed__secondary" onClick={toggleMute} disabled={phase === "connecting"} aria-pressed={muted}>
            {muted ? "Unmute" : "Mute mic"}
          </button>
        ) : null}
      </footer>

      {error ? <p className="voice-embed__error" role="alert">{error}</p> : null}
    </main>
  );
}
