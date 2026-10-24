import type { AvatarExpression, ConversationPhase, SemanticExpression } from "../types";

export const semanticExpressions: readonly SemanticExpression[] = [
  "neutral",
  "curious",
  "delighted",
  "amused",
  "joyful",
  "excited",
  "surprised",
  "skeptical",
  "confused",
  "concerned",
  "sad",
  "shy",
  "proud",
  "playful",
  "determined",
  "frustrated",
  "angry",
  "relieved",
  "sleepy",
] as const;

export const expressionLabels: Record<AvatarExpression, string> = {
  neutral: "Neutral",
  attentive: "Listening",
  thinking: "Thinking",
  curious: "Curious",
  delighted: "Delighted",
  amused: "Amused",
  joyful: "Joyful",
  excited: "Excited",
  surprised: "Surprised",
  skeptical: "Skeptical",
  confused: "Confused",
  concerned: "Concerned",
  sad: "Sad",
  shy: "Shy",
  proud: "Proud",
  playful: "Playful",
  determined: "Determined",
  frustrated: "Frustrated",
  angry: "Angry",
  relieved: "Relieved",
  sleepy: "Sleepy",
};

export function isSemanticExpression(value: unknown): value is SemanticExpression {
  return typeof value === "string" && semanticExpressions.includes(value as SemanticExpression);
}

export function expressionForPhase(
  phase: ConversationPhase,
  semantic: SemanticExpression,
): AvatarExpression {
  if (phase === "listening") return semantic === "neutral" ? "attentive" : semantic;
  if (phase === "thinking") return semantic === "neutral" ? "thinking" : semantic;
  if (phase === "connecting") return "thinking";
  if (phase === "error") return "concerned";
  return phase === "speaking" ? semantic : "neutral";
}
