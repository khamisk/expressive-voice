export type ConversationPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type SemanticExpression =
  | "neutral"
  | "curious"
  | "delighted"
  | "amused"
  | "joyful"
  | "excited"
  | "surprised"
  | "skeptical"
  | "confused"
  | "concerned"
  | "sad"
  | "shy"
  | "proud"
  | "playful"
  | "determined"
  | "frustrated"
  | "angry"
  | "relieved"
  | "sleepy";

export type AvatarExpression =
  | SemanticExpression
  | "attentive"
  | "thinking";
