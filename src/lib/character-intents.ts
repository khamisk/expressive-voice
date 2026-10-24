/** The purpose of a spoken beat, separate from its emotional expression. */
export const CHARACTER_INTENTS = [
  "react",
  "acknowledge",
  "question",
  "emphasize",
  "explain",
  "comfort",
  "celebrate",
  "joke",
  "realize",
  "correct",
  "consider",
  "reassure",
] as const;

export type CharacterIntent = (typeof CHARACTER_INTENTS)[number];

export function isCharacterIntent(value: unknown): value is CharacterIntent {
  return typeof value === "string" && CHARACTER_INTENTS.includes(value as CharacterIntent);
}
