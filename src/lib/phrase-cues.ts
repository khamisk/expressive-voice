import type { SemanticExpression } from "../types";
import { parseReactionCue, type ReactionCue } from "./reaction-cues";

/**
 * Input for the low-latency acting fallback. `phrase` must be the exact
 * assistant words that are about to be played, not a model summary or a
 * speculative completion. The out-of-band speech plan can replace this cue
 * later when it arrives for the same turn and anchor.
 */
export type FastSpeechCueInput = {
  turnId: string;
  phrase: string;
  userText?: string;
  phraseIndex?: number;
  cueId?: string;
};

type PhraseSignals = {
  positive: boolean;
  negative: boolean;
  empathy: boolean;
  humor: boolean;
  question: boolean;
  uncertainty: boolean;
  correction: boolean;
  insight: boolean;
  mixed: boolean;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isPositiveAcknowledgement(value: string): boolean {
  return matchesAny(normalizeText(value), [
    /^(?:oh[,\s]+)?(?:nice|great|awesome|amazing|fantastic|wonderful|wow)[!.]?$/iu,
    /\b(?:that(?:'s|\s+is)|so)\s+(?:nice|great|awesome|amazing|fantastic|wonderful)\b/iu,
  ]);
}

/**
 * This intentionally uses only high-signal phrase shapes. Generic words such
 * as “great”, “nice”, “hope”, and “like” are excluded so ordinary speech does
 * not become a fake emotional performance while the slower director is away.
 */
function signalsFor(value: string): PhraseSignals {
  const text = normalizeText(value);
  const positiveRaw = matchesAny(text, [
    /\b(?:finally\s+)?(?:got|landed|won|earned|passed|graduated|finished|shipped|sold|accepted)\s+(?:the|a|an)?\s*(?:job|role|apartment|promotion|customer|milestone|offer|exam|degree|project|deal)\b/iu,
    /\b(?:good|great)\s+news\b/iu,
    /\b(?:huge|big)\s+milestone\b/iu,
    /\b(?:congratulations?|well\s+done|(?:nice|great|awesome|fantastic)\s+(?:work|job)|you\s+did\s+it|proud\s+of\s+you|that(?:'s|\s+is)\s+(?:fantastic|wonderful)|glad\s+it\s+helped|enjoy\s+it|let's\s+celebrate)\b/iu,
  ]);
  const negatedSuccess = matchesAny(text, [
    /\b(?:didn['’]?t|did\s+not|never|no\s+longer|wasn['’]?t|isn['’]?t|can['’]?t|couldn['’]?t|won['’]?t)\s+(?:\w+\s+){0,3}(?:get|got|land|win|won|pass|passed|earn|earned|finish|finished|ship|shipped|sell|sold)\b/iu,
    /\bnot\s+(?:the|a|an)?\s*(?:job|role|apartment|promotion|customer|milestone|offer|exam|degree|project|deal)\b/iu,
    /\b(?:no|not|never)\s+(?:real\s+)?(?:good|great|fantastic|wonderful)\s+news\b/iu,
  ]);
  const negative = matchesAny(text, [
    /\b(?:rejection|rejected|bad\s+news|lost|crashed|failed|failure|hurt|pain|rough|brutal|nervous|anxious|worried|sad|upset|awful|terrible|didn['’]?t|did\s+not|wasn['’]?t|isn['’]?t|can['’]?t|couldn['’]?t|won['’]?t|moving\s+away|leaving\s+(?:my|your|their)?\s*friends|feel\s+the\s+tug)\b/iu,
  ]);
  const empathy = matchesAny(text, [
    /\b(?:sorry|rough|hard|brutal|sucks?|hurts?|awful|exhausting|tough|difficult|painful|shame|understand|valid|frustrating|makes\s+sense|hear\s+that|not\s+your\s+fault|feel\s+the\s+tug|put\s+so\s+much\s+into)\b/iu,
  ]);
  const humor = matchesAny(text, [
    /\b(?:ha(?:ha)?|funny|literal|joke|kidding|very\s+convincing|nice\s+try|clever|filed\s+the\s+complaint|the\s+day\s+behaves)\b/iu,
  ]);
  const question = /\?\s*$/u.test(text);
  const uncertainty = matchesAny(text, [
    /\b(?:not\s+sure|uncertain|wonder|maybe|might|perhaps|could\s+be|i\s+think)\b/iu,
  ]);
  const correction = matchesAny(text, [
    /\b(?:actually|to\s+clarify|instead|got\s+it|you['’]?re\s+right|you\s+are\s+right)\b/iu,
    /\bnot\b[^.!?]{0,48}\bbut\b/iu,
  ]);
  const insight = matchesAny(text, [
    /\b(?:aha|now\s+i\s+(?:see|get\s+it)|that(?:'s|\s+is)\s+why|that\s+explains|figured\s+it\s+out|we\s+solved|the\s+issue\s+was|there\s+it\s+is)\b/iu,
  ]);
  const contrast = /\b(?:but|although|though|still|yet|however|while)\b/iu.test(text);
  return {
    positive: positiveRaw && !negatedSuccess,
    negative,
    empathy,
    humor,
    question,
    uncertainty,
    correction,
    insight,
    mixed: contrast && positiveRaw && negative,
  };
}

function exactAnchor(phrase: string): string {
  const normalized = phrase.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const words = normalized.split(" ");
  let anchor = "";
  for (const word of words.slice(0, 5)) {
    const candidate = anchor ? `${anchor} ${word}` : word;
    if (candidate.length > 48) break;
    anchor = candidate;
  }
  return anchor;
}

function boundedIndex(value: number | undefined): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(31, value as number));
}

type FastDelivery = {
  gesture: NonNullable<ReactionCue["gesture"]>;
  accent: NonNullable<ReactionCue["accent"]>;
};

/**
 * Pick a finite delivery beat without changing what the phrase means. The
 * phrase director can replace this fallback later; while it is the only
 * signal available, successive anchored phrases should not all lean in with
 * the same eyes. `phraseIndex` is an ordering hint, never an emotion source.
 */
function deliveryForPhrase(phrase: string, intent: string, phraseIndex: number): FastDelivery | null {
  const beat = phraseIndex % 3;
  const wordCount = phrase.split(/\s+/u).filter(Boolean).length;

  if (intent === "comfort" || intent === "reassure") {
    if (beat === 0) return { gesture: "tilt-left", accent: "soften" };
    if (beat === 1) return { gesture: "nod", accent: "soften" };
    return { gesture: "settle", accent: "browless-wince" };
  }
  if (intent === "question") {
    if (beat === 0) return { gesture: "lean-in", accent: "widen" };
    if (beat === 1) return { gesture: "tilt-right", accent: "double-take" };
    return { gesture: "lean-in", accent: "widen" };
  }
  if (intent === "joke") {
    if (beat === 0) return { gesture: "tilt-right", accent: "spark" };
    if (beat === 1) return { gesture: "tilt-left", accent: "squint" };
    return { gesture: "nod", accent: "spark" };
  }
  if (intent === "realize") {
    if (beat === 0) return { gesture: "nod", accent: "widen" };
    if (beat === 1) return { gesture: "tilt-right", accent: "double-take" };
    return { gesture: "nod", accent: "spark" };
  }
  if (intent === "celebrate") {
    if (beat === 0) return { gesture: "lift", accent: "widen" };
    if (beat === 1) return { gesture: "nod", accent: "spark" };
    return { gesture: "tilt-right", accent: "widen" };
  }
  if (intent === "correct") {
    if (beat === 0) return { gesture: "nod", accent: "glance-down" };
    if (beat === 1) return { gesture: "nod", accent: "soften" };
    return { gesture: "settle", accent: "glance-down" };
  }
  // A short factual acknowledgement should stay quiet. A longer explanation
  // earns one intentional head beat so a multi-sentence fallback does not
  // stare forward for its entire duration.
  if ((intent === "explain" || intent === "acknowledge") && wordCount >= 6) {
    if (beat === 0) return { gesture: "nod", accent: "none" };
    if (beat === 1) return { gesture: "tilt-left", accent: "glance-up" };
    return { gesture: "tilt-right", accent: "glance-down" };
  }
  return null;
}

/**
 * Derive one conservative, exact-anchor cue without waiting for an OOB
 * analysis response. This is intentionally a fallback, not a second mood
 * model: ordinary explanation stays neutral and effects are always `none`.
 */
export function deriveFastSpeechCue(input: FastSpeechCueInput): ReactionCue | null {
  const phrase = input.phrase.replace(/\s+/gu, " ").trim();
  const anchor = exactAnchor(phrase);
  if (!phrase || !anchor || !/[\p{L}\p{N}]/u.test(phrase)) return null;

  const phraseSignals = signalsFor(phrase);
  const userSignals = signalsFor(input.userText ?? "");
  const positiveSupport = phraseSignals.positive
    || (userSignals.positive && isPositiveAcknowledgement(phrase));
  const index = boundedIndex(input.phraseIndex);
  let expression: SemanticExpression = "neutral";
  let intent: "explain" | "question" | "comfort" | "joke" | "celebrate" | "realize" | "reassure" | "correct" | "acknowledge" = "explain";
  let intensity = 0.45;
  let confidence = 0.68;
  let gesture: NonNullable<ReactionCue["gesture"]> = "still";
  let accent: NonNullable<ReactionCue["accent"]> = "none";

  if (phraseSignals.question) {
    expression = "curious";
    intent = "question";
    intensity = 0.82;
    confidence = 0.86;
    gesture = "lean-in";
    accent = "widen";
  } else if (phraseSignals.empathy && (phraseSignals.negative || userSignals.negative || userSignals.mixed)) {
    expression = "concerned";
    intent = "comfort";
    intensity = 0.82;
    confidence = 0.88;
    gesture = "lean-in";
    accent = "soften";
  } else if (phraseSignals.humor && !userSignals.negative && !userSignals.mixed) {
    expression = "amused";
    intent = "joke";
    intensity = 0.78;
    confidence = 0.82;
    gesture = "tilt-right";
    accent = "spark";
  } else if (phraseSignals.insight && (userSignals.negative || userSignals.uncertainty || userSignals.mixed)) {
    expression = "relieved";
    intent = "realize";
    intensity = 0.74;
    confidence = 0.8;
    gesture = "nod";
    accent = "widen";
  } else if (positiveSupport && !userSignals.negative && !userSignals.mixed) {
    expression = "delighted";
    intent = "celebrate";
    intensity = 0.82;
    confidence = 0.88;
    gesture = "lift";
    accent = "widen";
  } else if (phraseSignals.correction || userSignals.correction) {
    intent = userSignals.correction ? "correct" : "acknowledge";
    intensity = 0.48;
    confidence = 0.78;
    gesture = "settle";
    accent = "glance-down";
  } else if (phraseSignals.empathy && userSignals.negative) {
    expression = "concerned";
    intent = "reassure";
    intensity = 0.68;
    confidence = 0.76;
    gesture = "settle";
    accent = "soften";
  }

  const delivery = deliveryForPhrase(phrase, intent, index);
  if (delivery) {
    gesture = delivery.gesture;
    accent = delivery.accent;
  }

  const cue = parseReactionCue(JSON.stringify({
    kind: "speech",
    phraseIndex: index,
    expression,
    intent,
    intensity,
    effect: "none",
    confidence,
    gesture,
    accent,
    anchor,
  }), {
    id: input.cueId ?? `${input.turnId}:fast:${index}`,
    turnId: input.turnId,
    source: "assistant",
    currentUserText: input.userText,
    currentAssistantText: phrase,
    requireSpeechAnchor: true,
  });
  return cue;
}

export type ImmediateUserCueInput = {
  /** A finalized ASR/typed turn. Partial deltas must not call this helper. */
  turnId: string;
  text: string;
  cueId?: string;
};

const immediateWinPatterns: readonly RegExp[] = [
  /\b(?:i|we)\s+(?:finally\s+)?(?:got|landed|won|earned|passed|finished|shipped|sold|accepted)\s+(?:my|our|the|a|an)?\s*(?:(?:final|first|new|big|major)\s+)?(?:first\s+paying\s+customer|job|role|apartment|promotion|exam|test|degree|offer|project|deal|milestone|competition|contest|race|award|goal)\b/iu,
  /\b(?:i|we)\s+(?:finally\s+)?(?:got\s+promoted|was\s+promoted|earned\s+(?:the\s+)?promotion)\b/iu,
  /\b(?:i|we)\s+(?:finally\s+)?(?:hit|reached)\s+(?:a|the)?\s*(?:milestone|goal)\b/iu,
];

const immediateBadPatterns: readonly RegExp[] = [
  /\b(?:i|we)\s+(?:didn['’]?t|did\s+not|never|no\s+longer)\s+(?:get|land|win|pass|earn|finish|ship|sell)\s+(?:my|our|the|a|an)?\s*(?:job|role|apartment|promotion|exam|test|degree|offer|project|deal|milestone)\b/iu,
  /\b(?:i|we)\s+(?:got|received|was|were)\s+(?:rejected|a\s+rejection|bad\s+news)\b/iu,
  /\b(?:i|we)\s+(?:lost|failed|missed)\s+(?:my|our|the|a|an)?\s*(?:job|role|apartment|promotion|exam|test|degree|offer|project|deal|hour|hours|work)\b/iu,
  /\b(?:i(?:\s+am|['’]m)|we(?:\s+are|['’]re)|i\s+feel|i\s+felt)\s+(?:nervous|anxious|worried|sad|upset|hurt|devastated|exhausted)\b/iu,
  /\bmy\s+(?:laptop|computer|work|project|job)\s+(?:crashed|failed|was\s+rejected|is\s+broken)\b/iu,
  /\b(?:i|we)\s+(?:have|had)\s+(?:bad\s+news|a\s+problem|an\s+issue)\b/iu,
  /\b(?:i|we)\s+(?:was|were)\s+(?:rejected|laid\s+off|fired)\b/iu,
];

function firstMatch(value: string, patterns: readonly RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match;
  }
  return null;
}

function isUnsafeImmediateFraming(value: string, hasDirectEvent: boolean): boolean {
  if (!value || /["“”]/u.test(value) || /(?:…|\.\.\.)\s*$/u.test(value) || /\?/u.test(value)) return true;
  if (matchesAny(value, [
    /\b(?:if|what\s+if|would|could|might|maybe|imagine|suppose|hypothetical|wish)\b/iu,
    /\b(?:just\s+kidding|kidding|sarcasm|sarcastic|not\s+really|yeah\s*,?\s+right|sure\s*,?\s+right)\b/iu,
    /^(?:how|why|what|where|when|can|could|would|please|tell|make|write|build|explain)\b[^.!?]*[!?]?$/iu,
  ])) return true;

  // A direct first-person match wins over a separate mention of a friend in
  // the same turn. Without that direct match, never react to third-party news.
  const thirdPartyEvent = /\b(?:my\s+friend|a\s+friend|someone|he|she|they|their)\b[^.!?]{0,80}\b(?:got|landed|passed|won|failed|lost|rejected)\b/iu.test(value);
  return thirdPartyEvent && !hasDirectEvent;
}

function hasImmediateReversal(value: string): boolean {
  return matchesAny(value, [
    /\b(?:not\s+really|didn['’]?t|did\s+not|never|no\s+longer|rejected|failed|lost|fake|scam)\b/iu,
    /\b(?:but|although|though|however)\b[^.!?]{0,64}\b(?:nervous|anxious|worried|not|bad|awful|terrible|lost|failed)\b/iu,
    /(?:^|[.!?])\s*(?:not|nope|nah)\s*[.!?]?\s*$/iu,
  ]);
}

/**
 * Create the earliest safe user reaction from a complete turn. This is
 * intentionally much narrower than the OOB reaction director: it protects a
 * high-confidence win from being lost behind the first assistant phrase, but
 * returns null for ordinary, ambiguous, quoted, hypothetical, third-party,
 * sarcastic, or reversed text so the director remains authoritative.
 */
export function deriveImmediateUserCue(input: ImmediateUserCueInput): ReactionCue | null {
  const text = input.text.replace(/\s+/gu, " ").trim();
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const winMatch = firstMatch(text, immediateWinPatterns);
  const badMatch = firstMatch(text, immediateBadPatterns);
  if (isUnsafeImmediateFraming(text, Boolean(winMatch || badMatch))) return null;

  // A mixed update is intentionally deferred: the OOB read has the context
  // needed to distinguish earned joy from bittersweet or sarcastic wording.
  // Pure negative news can still get a quick, effect-free acknowledgement.
  if (winMatch && (badMatch || hasImmediateReversal(normalized))) return null;
  if (badMatch) {
    const anchor = exactAnchor(badMatch[0].trim());
    if (!anchor) return null;
    return parseReactionCue(JSON.stringify({
      expression: "concerned",
      intent: "comfort",
      intensity: 0.82,
      effect: "none",
      confidence: 0.92,
      gesture: "lean-in",
      accent: "soften",
      anchor,
    }), {
      id: input.cueId ?? `${input.turnId}:immediate`,
      turnId: input.turnId,
      source: "user",
      currentUserText: text,
    });
  }

  if (!winMatch) return null;
  const anchor = exactAnchor(winMatch[0]);
  if (!anchor) return null;
  return parseReactionCue(JSON.stringify({
    expression: "delighted",
    intent: "celebrate",
    intensity: 0.92,
    effect: "confetti",
    confidence: 0.97,
    gesture: "lift",
    accent: "widen",
    anchor,
  }), {
    id: input.cueId ?? `${input.turnId}:immediate`,
    turnId: input.turnId,
    source: "user",
    currentUserText: text,
  });
}
