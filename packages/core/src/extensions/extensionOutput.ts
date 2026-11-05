import { redactSecrets } from '../utils/secretRedaction.js';

export function redactExtensionOutput(value: unknown, secrets: string[], schema = false): unknown {
  const scrub = (text: string) => {
    let result = text;
    for (const secret of secrets.filter(Boolean)) {
      for (const spelling of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret)]) result = result.split(spelling).join('[REDACTED]');
    }
    return redactSecrets(result);
  };
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(v => redactExtensionOutput(v, secrets, schema));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [scrub(key), !schema && /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key) ? '[REDACTED]' : redactExtensionOutput(v, secrets, schema || key === 'inputSchema')]));
  return value;
}
/** Holds a bounded suffix so credentials split across subprocess chunks are
 * redacted before buffers, live output, diagnostics or session inspection. */
export class ExtensionStreamRedactor {
  private pending = '';
  private readonly spellings: string[];
  private readonly keep: number;
  constructor(secrets: string[]) {
    this.spellings = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret)]))];
    this.keep = Math.max(1, ...this.spellings.map(v => v.length)) - 1;
  }
  private scrub(value: string): string {
    for (const spelling of this.spellings) value = value.split(spelling).join('[REDACTED]');
    return value;
  }
  push(chunk: string): string {
    this.pending += chunk;
    let cut = Math.max(0, this.pending.length - this.keep);
    let previous: number;
    do {
      previous = cut;
      for (const spelling of this.spellings) {
      // Only matches crossing the boundary can affect the cut. Moving it
      // backwards is monotonic and never emits a partial credential.
      let position = this.pending.indexOf(spelling, Math.max(0, cut - spelling.length + 1));
      while (position >= 0 && position < cut) {
        if (position + spelling.length > cut) { cut = position; break; }
        position = this.pending.indexOf(spelling, position + 1);
      }
      }
    } while (cut > 0 && cut !== previous);
    const safe = this.scrub(this.pending.slice(0, cut)); this.pending = this.pending.slice(cut);
    return safe;
  }
  finish(): string { const safe = this.scrub(this.pending); this.pending = ''; return safe; }
}
