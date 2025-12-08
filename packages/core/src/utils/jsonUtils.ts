export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

export function parseLlmJson<T>(text: string): T {
  let clean = text.replace(/```json/g, '').replace(/```/g, '');
  
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  
  if (start === -1 || end === -1) {
    throw new JsonParseError('No JSON array found in LLM response');
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
