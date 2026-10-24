/**
 * Extracts JSON emitted by a director response that may be prefixed with
 * provider chatter or a partial stream. This deliberately scans syntax rather
 * than evaluating the response as JavaScript.
 */
export function completeJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

type ArrayLocation = { start: number };

function readJsonString(raw: string, start: number): { end: number; value: string } | null {
  if (raw[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      return { end: index, value: JSON.parse(raw.slice(start, index + 1)) as string };
    } catch {
      return null;
    }
  }
  return null;
}

function skipWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/u.test(raw[index])) index += 1;
  return index;
}

/** Find only an array named by a property on the first/root JSON object. */
function findTopLevelArray(raw: string, property: string): ArrayLocation | null {
  const objectStart = raw.indexOf("{");
  if (objectStart < 0) return null;

  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      // A quote can be a top-level property name only while the root object is
      // open and no nested array is being scanned.
      if (objectDepth === 1 && arrayDepth === 0) {
        const key = readJsonString(raw, index);
        if (!key) return null;
        const afterKey = skipWhitespace(raw, key.end + 1);
        if (raw[afterKey] === ":") {
          const valueStart = skipWhitespace(raw, afterKey + 1);
          if (key.value === property) {
            return raw[valueStart] === "[" ? { start: valueStart } : null;
          }
        }
        index = key.end;
        continue;
      }
      inString = true;
      continue;
    }
    if (character === "{") {
      objectDepth += 1;
      continue;
    }
    if (character === "}") {
      objectDepth = Math.max(0, objectDepth - 1);
      if (objectDepth === 0) return null;
      continue;
    }
    if (character === "[") {
      arrayDepth += 1;
      continue;
    }
    if (character === "]") arrayDepth = Math.max(0, arrayDepth - 1);
  }
  return null;
}

/** Find a complete object value beginning at `start`, respecting strings and nesting. */
function completeObjectEnd(raw: string, start: number): number | null {
  if (raw[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads complete object entries from a streaming top-level array. A partial
 * next object is intentionally ignored so cues can be emitted incrementally;
 * a completed scalar, malformed object, or other non-object entry is unsafe
 * and invalidates the whole result instead of being skipped.
 */
export function completeJsonObjectArray(raw: string, property: string): unknown[] | null {
  const location = findTopLevelArray(raw, property);
  if (!location) return null;

  const entries: unknown[] = [];
  let index = location.start + 1;
  while (true) {
    index = skipWhitespace(raw, index);
    if (index >= raw.length || raw[index] === "]") return entries;
    if (raw[index] !== "{") return null;

    const end = completeObjectEnd(raw, index);
    if (end === null) return entries;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(index, end + 1));
    } catch {
      return null;
    }
    if (!isJsonObject(parsed)) return null;
    entries.push(parsed);

    index = skipWhitespace(raw, end + 1);
    if (index >= raw.length || raw[index] === "]") return entries;
    if (raw[index] !== ",") return null;
    index += 1;
    if (raw[skipWhitespace(raw, index)] === "]") return null;
  }
}
