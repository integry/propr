export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

/**
 * Find the start of a JSON structure, preferring patterns that are more likely to be actual JSON
 * rather than code snippets that happen to contain { or [
 */
function findJsonStart(text: string): { start: number; type: 'object' | 'array' } | null {
  // Look for JSON-like patterns - find ALL matches and pick the earliest one
  // This ensures we get the outermost JSON structure, not a nested one
  const jsonPatterns = [
    { pattern: /\{\s*"/g, type: 'object' as const },      // {" - object with string key
    { pattern: /\[\s*\{/g, type: 'array' as const },      // [{ - array of objects
    { pattern: /\[\s*"/g, type: 'array' as const },       // [" - array of strings
    { pattern: /\[\s*\[/g, type: 'array' as const },      // [[ - nested array
    { pattern: /\{\s*\n/g, type: 'object' as const },     // {\n - object with newline
    { pattern: /\[\s*\n/g, type: 'array' as const },      // [\n - array with newline
  ];

  let earliest: { start: number; type: 'object' | 'array' } | null = null;

  for (const { pattern, type } of jsonPatterns) {
    const match = pattern.exec(text);
    if (match && (earliest === null || match.index < earliest.start)) {
      earliest = { start: match.index, type };
    }
  }

  if (earliest) {
    return earliest;
  }

  // Fallback to simple { or [ if no patterns matched
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');

  if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
    return { start: objectStart, type: 'object' };
  } else if (arrayStart !== -1) {
    return { start: arrayStart, type: 'array' };
  }

  return null;
}

/**
 * Escape control characters that appear inside JSON string literals.
 * Some LLMs write literal newlines/tabs in string values instead of escape
 * sequences; whitespace between tokens is left alone so pretty-printed JSON
 * stays valid.
 */
function escapeControlCharactersInStrings(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const charCode = text.charCodeAt(i);
    if (!inString) {
      if (char === '"') inString = true;
      result += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      result += char;
    } else if (char === '\\') {
      escaped = true;
      result += char;
    } else if (char === '"') {
      inString = false;
      result += char;
    } else if (charCode <= 31 || charCode === 127) {
      if (char === '\n') result += '\\n';
      else if (char === '\r') result += '\\r';
      else if (char === '\t') result += '\\t';
      // Other control characters are dropped.
    } else {
      result += char;
    }
  }
  return result;
}

/** Last-resort fixes for JS-style objects: trailing commas, single quotes, bare keys. */
function applyLooseJsonFixes(text: string): string {
  return text
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}')
    .replace(/'/g, '"')
    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
}

function describeParseError(error: unknown, text: string): string {
  const message = (error as Error).message;
  const posMatch = message.match(/position (\d+)/);
  if (!posMatch) return message;
  const pos = parseInt(posMatch[1], 10);
  const before = text.substring(Math.max(0, pos - 50), pos);
  const after = text.substring(pos, Math.min(text.length, pos + 50));
  return `${message} | Context: ...${before}>>>HERE(char=${text.charCodeAt(pos)})<<<${after}...`;
}

/**
 * The JSON document in an LLM response: code fences removed, from the first
 * JSON-looking opener to the last matching closer. This is the text that
 * parseLlmJson parses and that a file-based repair receives.
 */
export function extractLlmJsonText(text: string): string {
  const clean = text.replace(/```json/g, '').replace(/```/g, '');

  // Find the JSON structure using smart pattern matching
  const jsonLocation = findJsonStart(clean);

  if (!jsonLocation) {
    throw new JsonParseError('No JSON object or array found in LLM response');
  }

  const end = clean.lastIndexOf(jsonLocation.type === 'object' ? '}' : ']');
  if (end === -1) {
    throw new JsonParseError(jsonLocation.type === 'object' ? 'No closing brace found for JSON object' : 'No closing bracket found for JSON array');
  }

  return clean.substring(jsonLocation.start, end + 1);
}

export function parseLlmJson<T>(text: string): T {
  const clean = extractLlmJsonText(text);

  try {
    return JSON.parse(clean);
  } catch {
    // Literal control characters inside string values are the most common defect.
    const sanitized = escapeControlCharactersInStrings(clean);
    try {
      return JSON.parse(sanitized);
    } catch (sanitizedError) {
      // The loose fixes rewrite every single quote, so they only run when the
      // string-preserving pass failed; report that pass's error, which points
      // at the real defect rather than at damage done by the loose fixes.
      // Single-quoted strings only become strings here, so escape their
      // control characters again.
      try {
        return JSON.parse(escapeControlCharactersInStrings(applyLooseJsonFixes(sanitized)));
      } catch {
        throw new JsonParseError(`Failed to parse JSON: ${describeParseError(sanitizedError, sanitized)}`);
      }
    }
  }
}

/**
 * Returns the index of the bracket closing the JSON value opened at `start`,
 * honoring string literals, or -1 when the value is unbalanced or unterminated.
 */
function findBalancedJsonEnd(text: string, start: number): number {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return -1;
      if (closers.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts every top-level balanced JSON object/array substring from LLM output,
 * in order. Unlike a greedy first-`{`-to-last-`}` match, this survives responses
 * that contain the same JSON document more than once or trailing prose with braces.
 */
export function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char !== '{' && char !== '[') { i++; continue; }
    const end = findBalancedJsonEnd(text, i);
    if (end === -1) { i++; continue; }
    candidates.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return candidates;
}
