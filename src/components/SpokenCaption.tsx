import { useMemo } from "react";
import { captionWindow, type CaptionPlan } from "../lib/spoken-caption";

type SpokenCaptionProps = { text: string; visible: boolean; speaking: boolean; plan?: CaptionPlan };

/** Caption visibility never owns playback or the full transcript. */
export function SpokenCaption({ text, visible, speaking, plan }: SpokenCaptionProps) {
  const current = useMemo(() => captionWindow(text, {
    plannedText: plan?.text,
    breakBeforeWords: plan?.breaks,
  }), [text, plan]);

  return (
    <div className="transcript-slot">
      <div
        className={`speech-bubble ${visible && current.text ? "speech-bubble--visible" : ""} ${speaking ? "speech-bubble--live" : ""}`}
        role="region"
        aria-label="Spoken caption"
        aria-live="off"
        aria-hidden={!visible || !current.text}
        data-caption-window={current.startWord}
        data-caption-words={current.words.length}
      >
        <div className="speech-copy">
          {/* Spoken words track playback immediately. Crossfading two different
              thoughts here made the old and new sentences overlap visually. */}
          <span className={`caption-line ${speaking ? "caption-line--speaking" : ""}`} key={`in-${current.startWord}`} data-caption-current>
            {current.words.map((word, index) => (
              <span className="caption-word" key={current.startWord + index} data-word-index={current.startWord + index}>
                {index > 0 ? " " : ""}{word}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
