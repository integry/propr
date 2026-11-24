/**
 * Parse a provider's `.env` file the way python-dotenv (which Vibe uses) reads it:
 *
 * - blank lines and whole-line `#` comments are skipped, `export ` is allowed;
 * - a single- or double-quoted value ends at its closing quote and may span
 *   lines; anything after it must be whitespace or a `#` comment;
 * - double-quoted values decode `\\ \' \" \a \b \f \n \r \t \v`, single-quoted
 *   values decode `\\` and `\'`;
 * - an unquoted value runs to the end of the line, minus a `#` comment that
 *   follows whitespace (`a#b` keeps its `#`), and is trimmed.
 *
 * Lines that do not parse are skipped, as python-dotenv skips them with a
 * warning. Variable interpolation is not applied.
 */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
    '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
};
const SINGLE_QUOTED_ESCAPES: Record<string, string> = { '\\': '\\', "'": "'" };

const ASSIGNMENT = /[ \t]*(?:export[ \t]+)?([^=#\s]+)[ \t]*=[ \t]*/y;
const AFTER_QUOTED = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;

function lineEnd(content: string, from: number): number {
    const index = content.indexOf('\n', from);
    return index === -1 ? content.length : index + 1;
}

/** Index just after the closing `quote` of a value opening at `start`, or -1. */
function closingQuote(content: string, start: number, quote: string): number {
    for (let index = start + 1; index < content.length; index++) {
        if (content[index] === '\\' && index + 1 < content.length) { index++; continue; }
        if (content[index] === quote) return index + 1;
    }
    return -1;
}

function decode(raw: string, escapes: Record<string, string>): string {
    return raw.replace(/\\(.)/gs, (match, character: string) => escapes[character] ?? match);
}

export function parseDotenv(content: string): Map<string, string> {
    const values = new Map<string, string>();
    const text = content.replace(/^\uFEFF/, '');
    let position = 0;
    while (position < text.length) {
        ASSIGNMENT.lastIndex = position;
        const assignment = ASSIGNMENT.exec(text);
        if (!assignment) { position = lineEnd(text, position); continue; }
        const name = assignment[1];
        const valueStart = ASSIGNMENT.lastIndex;
        const quote = text[valueStart];
        if (quote === '"' || quote === "'") {
            const end = closingQuote(text, valueStart, quote);
            AFTER_QUOTED.lastIndex = end;
            if (end === -1 || !AFTER_QUOTED.exec(text)) { position = lineEnd(text, valueStart); continue; }
            values.set(name, decode(text.slice(valueStart + 1, end - 1), quote === '"' ? DOUBLE_QUOTED_ESCAPES : SINGLE_QUOTED_ESCAPES));
            position = AFTER_QUOTED.lastIndex;
            continue;
        }
        const next = lineEnd(text, valueStart);
        const raw = text.slice(valueStart, next).replace(/\r?\n$/, '');
        values.set(name, raw.replace(/\s+#.*$/s, '').trim());
        position = next;
    }
    return values;
}
