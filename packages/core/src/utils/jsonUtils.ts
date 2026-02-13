export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

export function parseLlmJson<T>(text: string): T {
  let clean = text.replace(/```json/g, '').replace(/```/g, '');

  // Find the first JSON structure (object or array)
  const arrayStart = clean.indexOf('[');
  const objectStart = clean.indexOf('{');

  let start: number;
  let end: number;

  if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
    // Object comes first - extract the object
    start = objectStart;
    end = clean.lastIndexOf('}');
    if (end === -1) {
      throw new JsonParseError('No closing brace found for JSON object');
    }
  } else if (arrayStart !== -1) {
    // Array comes first - extract the array
    start = arrayStart;
    end = clean.lastIndexOf(']');
    if (end === -1) {
      throw new JsonParseError('No closing bracket found for JSON array');
    }
  } else {
    throw new JsonParseError('No JSON object or array found in LLM response');
  }

  clean = clean.substring(start, end + 1);

  try {
    return JSON.parse(clean);
  } catch (firstError) {
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
      const sanitized = clean
        .replace(/[\x00-\x1F\x7F]/g, (char) => {
          // Preserve escaped sequences that are valid in JSON strings
          if (char === '\n') return '\\n';
          if (char === '\r') return '\\r';
          if (char === '\t') return '\\t';
          // Remove other control characters
          return '';
        });

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
