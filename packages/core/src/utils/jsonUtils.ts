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
 * Sanitize control characters in a string for JSON parsing.
 * Replaces literal control characters with their escape sequences.
 */
function sanitizeControlCharacters(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const char = text[i];
    // Check for control characters (0x00-0x1F and 0x7F)
    if ((charCode >= 0 && charCode <= 31) || charCode === 127) {
      // Preserve escaped sequences that are valid in JSON strings
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      }
      // Remove other control characters (add nothing)
    } else {
      result += char;
    }
  }
  return result;
}

export function parseLlmJson<T>(text: string): T {
  let clean = text.replace(/```json/g, '').replace(/```/g, '');

  // Find the JSON structure using smart pattern matching
  const jsonLocation = findJsonStart(clean);

  if (!jsonLocation) {
    throw new JsonParseError('No JSON object or array found in LLM response');
  }

  let start: number;
  let end: number;

  if (jsonLocation.type === 'object') {
    start = jsonLocation.start;
    end = clean.lastIndexOf('}');
    if (end === -1) {
      throw new JsonParseError('No closing brace found for JSON object');
    }
  } else {
    start = jsonLocation.start;
    end = clean.lastIndexOf(']');
    if (end === -1) {
      throw new JsonParseError('No closing bracket found for JSON array');
    }
  }

  clean = clean.substring(start, end + 1);

  try {
    return JSON.parse(clean);
  } catch {
    // Try fixing common issues
    clean = clean
      .replace(/,\s*]/g, ']')
      .replace(/,\s*}/g, '}')
      .replace(/'/g, '"')
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    try {
      return JSON.parse(clean);
    } catch (secondError) {
      // Try to sanitize control characters that might be breaking JSON
      // Some LLMs output literal control characters instead of escape sequences
      const sanitized = sanitizeControlCharacters(clean);

      try {
        return JSON.parse(sanitized);
      } catch (thirdError) {
        // Provide detailed error with context around the error position
        const err = thirdError as SyntaxError;
        const posMatch = err.message.match(/position (\d+)/);
        let context = '';
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10);
          const start = Math.max(0, pos - 50);
          const end = Math.min(sanitized.length, pos + 50);
          const before = sanitized.substring(start, pos);
          const after = sanitized.substring(pos, end);
          const charCode = sanitized.charCodeAt(pos);
          context = ` | Context: ...${before}>>>HERE(char=${charCode})<<<${after}...`;
        }
        throw new JsonParseError(`Failed to parse JSON: ${(secondError as Error).message}${context}`);
      }
    }
  }
}
