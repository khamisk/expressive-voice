import { useEffect, useMemo, useRef, useState } from "react";
import { PerformanceAvatar } from "./components/PerformanceAvatar";
import { ExpressionGallery } from "./components/ExpressionGallery";
import { PerformanceStudio } from "./components/PerformanceStudio";
import { Switch } from "./components/Switch";
import { SpokenCaption } from "./components/SpokenCaption";
import {
  expressionForPhase,
  expressionLabels,
  isSemanticExpression,
} from "./lib/expressions";
import { RealtimeVoiceClient, type ReactionDiagnostic, type TransportDiagnostic } from "./lib/realtime";
import type { VoiceActivity } from "./lib/speech-performance";
import type { ReactionCue } from "./lib/reaction-cues";
import type { ConversationPhase, SemanticExpression } from "./types";
import { DevAudioInput, type DevAudioInputState } from "./lib/dev-audio-input";
import type { CaptionPlan } from "./lib/spoken-caption";
import type { CharacterDisplayState } from "./lib/voice-character";

const voiceInputFixtures = [
  ["job-win", "Good news"],
  ["yeah", "Brief yeah"],
  ["substantive-correction", "Correction"],
  ["stop-and-repeat", "Stop and repeat"],
  ["disappointing-correction", "Disappointment"],
  ["changing-intent-story", "Changing intent"],
] as const;

const previewPhases: ConversationPhase[] = ["idle", "connecting", "listening", "thinking", "speaking", "error"];

function readPreviewState(): { phase: ConversationPhase; expression: SemanticExpression } | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  const phase = params.get("phase");
  const expression = params.get("expression");
  if (!phase && !expression) return null;
  return {
    phase: previewPhases.includes(phase as ConversationPhase) ? (phase as ConversationPhase) : "speaking",
    expression: isSemanticExpression(expression) ? expression : "delighted",
  };
}

export default function App() {
  const showExpressionGallery = useMemo(
    () => import.meta.env.DEV && new URLSearchParams(window.location.search).get("gallery") === "expressions",
    [],
  );
  const preview = useMemo(readPreviewState, []);
  const testMode = useMemo(() => import.meta.env.DEV && new URLSearchParams(window.location.search).get("syntheticAudio") === "1", []);
  const audioTestMode = useMemo(() => import.meta.env.DEV && new URLSearchParams(window.location.search).get("voiceQA") === "1", []);
  const studioMode = useMemo(() => import.meta.env.DEV && new URLSearchParams(window.location.search).get("studio") === "performance", []);
  const [phase, setPhase] = useState<ConversationPhase>(preview?.phase ?? "idle");
  const [semanticExpression, setSemanticExpression] = useState<SemanticExpression>(preview?.expression ?? "neutral");
  const [showMood, setShowMood] = useState(true);
  const [showTranscript, setShowTranscript] = useState(true);
  const [transcript, setTranscript] = useState(
    preview ? "That is a genuinely lovely idea. Let's make it feel alive." : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [captionPlan, setCaptionPlan] = useState<CaptionPlan | undefined>();
  const [reactionCue, setReactionCue] = useState<ReactionCue | null>(null);
  const [reactionDiagnostic, setReactionDiagnostic] = useState<ReactionDiagnostic | null>(null);
  const [reactionDiagnostics, setReactionDiagnostics] = useState<ReactionDiagnostic[]>([]);
  const [transportDiagnostics, setTransportDiagnostics] = useState<TransportDiagnostic[]>([]);
  const [testUserTranscript, setTestUserTranscript] = useState("");
  const [sessionInstructions, setSessionInstructions] = useState("");
  const [testTurn, setTestTurn] = useState("");
  const [inputState, setInputState] = useState<DevAudioInputState | null>(null);
  const [handoff, setHandoff] = useState("");
  const devInputRef = useRef<DevAudioInput | null>(null);
  const clientRef = useRef<RealtimeVoiceClient | null>(null);
  const activityRef = useRef<VoiceActivity>({ input: 0, output: 0 });
  const presentationRef = useRef<CharacterDisplayState | null>(null);
  const phaseRef = useRef<ConversationPhase>(preview?.phase ?? "idle");
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantTranscriptRef = useRef(transcript);
  const userTranscriptRef = useRef("");
  const retainedUserCueRef = useRef<ReactionCue | null>(null);
  const hasConversation = !["idle", "error"].includes(phase);
  const isPending = phase === "connecting";
  const canEndConversation = hasConversation && !isPending;
  const effectiveExpression = expressionForPhase(phase, semanticExpression);

  useEffect(() => () => {
    clientRef.current?.close();
    devInputRef.current?.close();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  useEffect(() => {
    const forceMotion = import.meta.env.DEV
      && new URLSearchParams(window.location.search).get("motion") === "full";
    document.documentElement.classList.toggle("force-motion", forceMotion);
    return () => document.documentElement.classList.remove("force-motion");
  }, []);

  const clearSettling = () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  };

  const startConversation = async () => {
    if (preview) return;
    setError(null);
    setTranscript("");
    setCaptionPlan(undefined);
    setSemanticExpression("neutral");
    setReactionCue(null);
    setReactionDiagnostic(null);
    setReactionDiagnostics([]);
    setTransportDiagnostics([]);
    setTestUserTranscript("");
    setSessionInstructions("");
    setHandoff("");
    setInputState(null);
    activityRef.current = { input: 0, output: 0, wordTick: 0, phraseTick: 0, punctuation: "none" };
    clearSettling();
    assistantTranscriptRef.current = "";
    userTranscriptRef.current = "";
    retainedUserCueRef.current = null;

    const client = new RealtimeVoiceClient({
      getCharacterState: () => presentationRef.current,
      onPhase: (nextPhase) => {
        const previousPhase = phaseRef.current;
        if (nextPhase === previousPhase) return;
        clearSettling();
        if (nextPhase === "thinking") {
          // Recognizing the user's news does not depend on the assistant
          // having started audio. Keep that same face through voice startup.
          const recognized = retainedUserCueRef.current;
          setSemanticExpression(recognized?.expression ?? "neutral");
          setReactionCue(recognized);
        }
        if (nextPhase === "listening" && (previousPhase === "speaking" || previousPhase === "thinking")) {
          // A face-only answer has no audio tail to give the gesture reading
          // time. Let its authored tilt/settle finish before returning idle.
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
          devInputRef.current?.close();
          devInputRef.current = null;
          setInputState(null);
        }
        phaseRef.current = nextPhase;
        setPhase(nextPhase);
      },
      onTranscriptReset: () => {
        assistantTranscriptRef.current = "";
        activityRef.current.wordTick = 0;
        activityRef.current.phraseTick = 0;
        activityRef.current.punctuation = "none";
        setTranscript("");
      },
      onTranscriptDelta: (delta) => {
        const next = assistantTranscriptRef.current + delta;
        assistantTranscriptRef.current = next;
        setTranscript(next);
      },
      onCaptionPlan: setCaptionPlan,
      onUserTranscriptReset: () => {
        userTranscriptRef.current = "";
        if (testMode || audioTestMode) setTestUserTranscript("");
        retainedUserCueRef.current = null;
        if (phaseRef.current !== "speaking") {
          clearSettling();
          setSemanticExpression("neutral");
          setReactionCue(null);
        }
      },
      onUserTranscriptDelta: (delta) => {
        const next = userTranscriptRef.current + delta;
        userTranscriptRef.current = next;
        if (testMode || audioTestMode) setTestUserTranscript(next);
      },
      onReactionCue: (cue) => {
        clearSettling();
        retainedUserCueRef.current = cue.source === "user" ? cue : null;
        setSemanticExpression(cue.expression);
        setReactionCue(cue);
      },
      onReactionDiagnostic: import.meta.env.DEV ? (diagnostic) => {
        setReactionDiagnostic(diagnostic);
        setReactionDiagnostics((previous) => [...previous.slice(-39), diagnostic]);
      } : undefined,
      onSessionInstructions: import.meta.env.DEV ? setSessionInstructions : undefined,
      onTransportDiagnostic: import.meta.env.DEV && (testMode || audioTestMode)
        ? (event) => setTransportDiagnostics((previous) => [...previous.slice(-119), event])
        : undefined,
      onAmplitude: (source, amplitude) => {
        activityRef.current[source] = amplitude;
      },
      onPlaybackWord: ({ wordTick, phraseTick, punctuation }) => {
        Object.assign(activityRef.current, { wordTick, phraseTick, punctuation });
      },
      onHandoff: import.meta.env.DEV ? setHandoff : undefined,
      onError: setError,
    });

    clientRef.current = client;
    try {
      const syntheticInput = import.meta.env.DEV
        && new URLSearchParams(window.location.search).get("syntheticAudio") === "1";
      const initialText = import.meta.env.DEV
        ? new URLSearchParams(window.location.search).get("voiceTestText") ?? undefined
        : undefined;
      devInputRef.current?.close();
      devInputRef.current = audioTestMode ? new DevAudioInput({ onState: setInputState }) : null;
      await client.connect({ syntheticInput, inputStream: devInputRef.current?.stream(), initialText });
    } catch {
      clientRef.current = null;
      devInputRef.current?.close();
      devInputRef.current = null;
    }
  };

  const endConversation = () => {
    clientRef.current?.close();
    clientRef.current = null;
    devInputRef.current?.close();
    devInputRef.current = null;
    setInputState(null);
    activityRef.current = { input: 0, output: 0, wordTick: 0, phraseTick: 0, punctuation: "none" };
    setError(null);
    phaseRef.current = "idle";
    setTranscript("");
    setCaptionPlan(undefined);
    setSemanticExpression("neutral");
    setReactionCue(null);
    retainedUserCueRef.current = null;
    clearSettling();
    assistantTranscriptRef.current = "";
    userTranscriptRef.current = "";
  };

  const handlePrimaryAction = () => {
    if (hasConversation) endConversation();
    else void startConversation();
  };

  const buttonLabel = isPending ? "Connecting" : canEndConversation ? "End conversation" : "Start talking";

  if (showExpressionGallery) return <ExpressionGallery />;
  if (studioMode) return <PerformanceStudio />;

  return (
    <main className="app-shell">
      <aside className="display-controls" aria-label="Display options">
        <Switch checked={showMood} onChange={setShowMood} label="Show mood" />
        <Switch checked={showTranscript} onChange={setShowTranscript} label="Show transcript" />
      </aside>

      <section className="conversation-stage" aria-label="AI voice conversation">
        <div className="avatar-frame">
          <PerformanceAvatar
            expression={effectiveExpression}
            phase={phase}
            activityRef={activityRef}
            presentationRef={presentationRef}
            cue={reactionCue}
          />
        </div>

        <SpokenCaption text={transcript} plan={captionPlan} visible={showTranscript} speaking={phase === "speaking"} />

        <div className="action-area">
          <div className={`mood-readout ${showMood ? "mood-readout--visible" : ""}`} aria-live="polite">
              <span className="mood-label" key={effectiveExpression} aria-hidden={!showMood}>
                {expressionLabels[effectiveExpression]}
              </span>
          </div>
          <button
            className={`talk-button ${canEndConversation ? "talk-button--active" : ""}`}
            type="button"
            onClick={handlePrimaryAction}
            disabled={isPending}
            aria-describedby={error ? "connection-error" : undefined}
          >
            <span className={`button-state-icon ${isPending ? "button-state-icon--pending" : ""}`} aria-hidden="true">
              {isPending ? "" : canEndConversation ? <span className="stop-mark" /> : <span className="mic-mark" />}
            </span>
            <span className="button-label" key={buttonLabel}>
              {buttonLabel}
            </span>
          </button>
          {error ? (
            <p className="connection-error" id="connection-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      {testMode && (
        <form className="voice-test-tools" onSubmit={(event) => {
          event.preventDefault();
          if (testTurn.trim() && clientRef.current) {
            clientRef.current.sendTextTurn(testTurn.trim());
            setTestTurn("");
          }
        }}>
          <label htmlFor="test-turn">Live test · typed input, real voice</label>
          <div><input id="test-turn" value={testTurn} onChange={(event) => setTestTurn(event.target.value)} placeholder="Send a test turn" /><button type="submit" disabled={!hasConversation || !testTurn.trim()}>Send</button></div>
          <output
            className="reaction-test-status"
            data-reaction-state={reactionDiagnostic?.state ?? "idle"}
            data-reaction-turn={reactionDiagnostic?.turnId}
            data-reaction-ms={reactionDiagnostic?.elapsedMs}
            data-reaction-reason={reactionDiagnostic?.reason}
            data-diagnostics={JSON.stringify(reactionDiagnostics)}
            data-current-cue={JSON.stringify(reactionCue)}
            data-session-instructions={sessionInstructions}
          >
            Reaction: {reactionDiagnostic?.state ?? "idle"}
            {reactionDiagnostic?.elapsedMs !== undefined ? ` · ${reactionDiagnostic.elapsedMs} ms` : ""}
          </output>
        </form>
      )}

      {audioTestMode && (
        <section className="voice-test-tools audio-input-tools" aria-label="Developer audio-input verification">
          <strong>Voice QA · recorded input, live AI response</strong>
          <p>Start the conversation, then send a recording. Try “Brief yeah” or “Correction” while it talks. This does not test your physical microphone.</p>
          <div className="audio-input-tools__buttons">
            {voiceInputFixtures.map(([id, label]) => (
              <button type="button" key={id} disabled={!hasConversation || isPending || inputState?.phase === "loading" || inputState?.phase === "playing"} onClick={() => {
                setError(null);
                void devInputRef.current?.playFixture(`/voice-input/${id}.wav`).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Recording couldn't play."));
              }}>{label}</button>
            ))}
            <button type="button" disabled={inputState?.phase !== "playing" && inputState?.phase !== "loading"} onClick={() => devInputRef.current?.stop()}>Stop input</button>
          </div>
          <output data-input-state={inputState?.phase ?? "idle"} data-handoff={handoff} data-current-cue={JSON.stringify(reactionCue)}>
            Input: {inputState?.phase ?? "idle"} · Voice: {phase}{handoff ? ` · Handoff: ${handoff}` : ""}
          </output>
        </section>
      )}

      {(testMode || audioTestMode) && (
        <output hidden aria-hidden="true" data-transport={JSON.stringify(transportDiagnostics)} data-user-transcript={testUserTranscript} data-presented-transcript={transcript} />
      )}

      <p className="sr-only" role="status" aria-live="polite">
        Conversation state: {phase}
      </p>
    </main>
  );
}
