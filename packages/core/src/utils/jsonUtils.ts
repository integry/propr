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
  } catch {
    clean = clean
      .replace(/,\s*]/g, ']')
      .replace(/,\s*}/g, '}')
      .replace(/'/g, '"')
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    try {
      return JSON.parse(clean);
    } catch (e) {
      throw new JsonParseError(`Failed to parse JSON: ${(e as Error).message}`);
    }
  }
}
