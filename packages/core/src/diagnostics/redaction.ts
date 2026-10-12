export const REDACTION_VERSION = 1;
const credentialCountLimit = 512, credentialBytesLimit = 512 * 1024;
/** One cache per process, even if this module is loaded from both source and
 * dist (or another duplicate path). The versioned key isolates shape changes. */
export function processDiagnosticState<T extends object>(name: string, create: () => T): T {
    const registry = globalThis as unknown as Record<symbol, T | undefined>;
    return registry[Symbol.for(`@propr/core/diagnostics/${name}`)] ??= create();
}
const remembered = processDiagnosticState('credentials@1', () => ({ values: new Set<string>(), bytes: 0 }));
/** Process-local, insertion-ordered cache; evict old credentials rather than
 * disabling application capture. Learned values never enter status or manifests. */
export function rememberDiagnosticCredentials(values: readonly string[]): void {
    for (const value of values) {
        if (value.length < 8 || value.length > credentialBytesLimit || remembered.values.has(value)) continue;
        while (remembered.values.size >= credentialCountLimit || remembered.bytes + value.length > credentialBytesLimit) {
            const oldest = remembered.values.values().next().value!;
            remembered.values.delete(oldest); remembered.bytes -= oldest.length;
        }
        remembered.values.add(value); remembered.bytes += value.length;
    }
}
export function diagnosticCredentials(): readonly string[] {
    return [...remembered.values];
}
const authField = /auth|token|cookie|password|passwd|secret|credential|private.?key|api.?key|^headers$/i;
const known = /(?:\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]+|AIza[a-zA-Z0-9_-]{20,})\b|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/g;
export function redactRecord(line: string, format: 'jsonl' | 'text', credentials: readonly string[]): string | null {
    if (credentials.length > 512 || credentials.reduce((n, value) => n + value.length, 0) > 512 * 1024) return null;
    // eslint-disable-next-line no-control-regex -- Intentionally reject control characters except tab, LF, and CR.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) return null;
    if (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim()) || line.includes('\uFFFD') || /-----BEGIN .*PRIVATE KEY-----/.test(line)) return null;
    const text = (value: string): string => {
        for (const credential of credentials) if (credential.length >= 8) {
            for (const variant of [credential, encodeURIComponent(credential), JSON.stringify(credential).slice(1, -1)]) value = value.split(variant).join('[REDACTED]');
        }
        return value.replace(known, '[REDACTED]')
            .replace(/(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [REDACTED]')
            .replace(/((?:password|passwd|secret|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
            .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    };
    const walk = (value: unknown, depth = 0): unknown => {
        if (depth > 32) throw new Error('depth');
        if (typeof value === 'string') return text(value);
        if (Array.isArray(value)) return value.map(v => walk(v, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [text(key), authField.test(key) ? '[REDACTED]' : walk(v, depth + 1)]));
        return value;
    };
    try {
        if (format === 'jsonl') {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return JSON.stringify(walk(parsed)) + '\n';
        }
        // JSON-looking text is never allowed to bypass structured redaction.
        if (/^\s*\{/.test(line)) return redactRecord(line, 'jsonl', credentials);
        // Native text adapters recognize single-line timestamp/severity logs.
        // Unknown continuation lines cannot bypass malformed structured/auth data.
        if (!/^\s*(?:\d{4}-\d{2}-\d{2}[T ]|\[(?:\d{4}-|TRACE\b|DEBUG\b|INFO\b|WARN\b|ERROR\b|FATAL\b)|TRACE\b|DEBUG\b|INFO\b|WARN(?:ING)?\b|ERROR\b|FATAL\b)/i.test(line)) return null;
        if (/(?:password|secret|credential|authorization|token|api[_-]?key)["']?\s*[:=]\s*$/.test(line)) return null;
        const objectStart = line.indexOf('{');
        if (objectStart >= 0) {
            const structured = redactRecord(line.slice(objectStart), 'jsonl', credentials);
            if (!structured) return null;
            return JSON.stringify({ message: text(line.slice(0, objectStart)), record: JSON.parse(structured) }) + '\n';
        }
        return JSON.stringify({ message: text(line) }) + '\n';
    } catch { return null; }
}
