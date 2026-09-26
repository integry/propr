/**
 * Record field grammar shared by the private reviewer contract, the public
 * comment contract, and every serializer that feeds `/fix`.
 *
 * A field starts on an unindented `- **name:** value` (or `- name: value`)
 * line. It continues on the lines that follow until the next unindented field
 * line, a thematic break (`---`), or the end of the record:
 *   - blank lines separate paragraphs and list blocks inside the field;
 *   - indented lines (space or tab) hold paragraphs, numbered or bulleted
 *     lists, nested label-like text, and fenced code; and
 *   - unindented paragraph text directly after a non-blank field line is a
 *     Markdown lazy continuation of that paragraph, unless it starts a block.
 *
 * Only unindented field lines and the `### F#`/`### S#` and `## ` headings
 * that delimit records and sections are structural, so indented text that
 * looks like a label, list item, or heading always stays inside its field.
 * Any other unindented content — text before the first field, a top-level
 * list item, heading, or table, content after a thematic break, or text that
 * escapes an open code fence — is unsupported. It rejects the record instead
 * of being silently dropped from otherwise complete-looking evidence.
 *
 * Values keep the first line as written and dedent continuation lines by
 * their common indentation, so renderers can indent them beneath any
 * `- **label:**` bullet without changing their Markdown structure. A value
 * that starts below an empty field line can therefore open with an indented
 * line, which renderers keep below the label.
 *
 * Tabs in a line's indentation and after its list markers expand to spaces at
 * four-column tab stops before any of this, so nesting does not depend on the
 * columns at which renderers later place the line. A first line that
 * renderers move below the label expands the same way from the field's
 * content column.
 *
 * Code fences are tracked on those dedented lines, the same shape a renderer
 * publishes, relative to the list item that contains them: an opener or
 * closer indented four or more columns past its item's content is literal
 * code, and a fenced line indented less than that content leaves the item
 * unless it continues that item's paragraph.
 */

const FIELD_BOLD_RE = /^[-*][ \t]+\*\*([^*]+)\*\*[ \t]*(.*)$/;
const FIELD_PLAIN_RE = /^[-*][ \t]+([A-Za-z][A-Za-z0-9 -]*):[ \t]*(.*)$/;
const THEMATIC_BREAK_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/**
 * A code fence opener. A backtick fence's info string cannot contain a
 * backtick, so a line that starts with a closed three-backtick inline code
 * span is paragraph text, not a fence.
 */
const FENCE_OPEN_SOURCE = '(`{3,})[^`]*$|(~{3,})';
const FENCE_RE = new RegExp(`^(?:${FENCE_OPEN_SOURCE})`);
/** One list item marker; nested items such as `- 1. ` repeat it on one line. */
const LIST_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)])([ \t]+)/;
/** Unindented text that would open a new Markdown block rather than continue a paragraph. */
const BLOCK_START_RE = new RegExp(`^(?:[-*+](?:[ \\t]|$)|\\d{1,9}[.)](?:[ \\t]|$)|#{1,6}(?:[ \\t]|$)|>|${FENCE_OPEN_SOURCE}|\\||<)`);
const HEADING_RE = /^#{1,6}(?:[ \t]|$)/;

interface FieldHeader {
    key: string;
    value: string;
}

function matchFieldHeader(line: string): FieldHeader | null {
    const match = FIELD_BOLD_RE.exec(line) ?? FIELD_PLAIN_RE.exec(line);
    if (!match) return null;
    return {
        key: match[1].replace(/:$/, '').replace(/[\s-]/g, '').toLowerCase(),
        value: match[2].replace(/^:\s*/, '').trim(),
    };
}

/** Whether any line of a record body is shaped like a top-level field line. */
export function hasRecordFieldHeader(block: string): boolean {
    return block.split(/\r?\n/).some(line => matchFieldHeader(line) !== null);
}

interface ContinuationLine {
    text: string;
    lazy: boolean;
}

interface OpenField {
    key: string;
    first: string;
    continuation: ContinuationLine[];
}

function dedentContinuation(field: OpenField): ContinuationLine[] {
    const indents = field.continuation
        .filter(line => !line.lazy && line.text !== '')
        .map(line => line.text.length - line.text.trimStart().length);
    const dedent = indents.length > 0 ? Math.min(...indents) : 0;
    return field.continuation.map(line => (line.lazy ? line : { text: line.text.slice(dedent), lazy: false }));
}

function buildFieldValue(first: string, continuation: ContinuationLine[]): string {
    const lines = [first, ...continuation.map(line => line.text)];
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
}

/** The column just past `whitespace` that starts at `column`, with tab stops every four columns. */
function advanceColumn(column: number, whitespace: string): number {
    for (const char of whitespace) column = char === '\t' ? column + 4 - (column % 4) : column + 1;
    return column;
}

/**
 * Expand the tabs in a line's indentation and in the whitespace after its
 * leading list markers, such as `-\t1.\t`, to spaces at their tab stops.
 */
function expandStructuralTabs(line: string): string {
    let expanded = '';
    let rest = line;
    for (;;) {
        const whitespace = /^[ \t]*/.exec(rest)![0];
        expanded += ' '.repeat(advanceColumn(expanded.length, whitespace) - expanded.length);
        rest = rest.slice(whitespace.length);
        const marker = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t])/.exec(rest);
        if (!marker) return expanded + rest;
        expanded += marker[0];
        rest = rest.slice(marker[0].length);
    }
}

/** Whether `content`, with its indentation removed, would start a block instead of continuing a paragraph. */
function startsBlock(content: string): boolean {
    return BLOCK_START_RE.test(content) || THEMATIC_BREAK_RE.test(content);
}

/** Whether non-fence `content` in a list item, with its indentation and markers removed, is paragraph text. */
function isParagraphText(content: string): boolean {
    return content !== '' && !HEADING_RE.test(content) && !THEMATIC_BREAK_RE.test(content);
}

/**
 * Open the list items whose markers start `text` at `indent`, pushing their
 * content columns onto `items`, and return the column and text after them.
 */
function enterListItems(items: number[], indent: number, text: string): { column: number; rest: string } {
    let column = indent;
    let rest = text.slice(indent);
    // A fence can open a list item, as in `- ~~~ts`; its closer then sits
    // at the item's content column without a marker. Text four or more
    // columns past the containing item's content is literal code, so a
    // marker-shaped `- ~~~` there opens neither an item nor a fence.
    for (
        let marker = LIST_MARKER_RE.exec(rest);
        marker && column - items[items.length - 1] < 4;
        marker = LIST_MARKER_RE.exec(rest)
    ) {
        const markerEnd = column + marker[0].length - marker[1].length;
        column = advanceColumn(markerEnd, marker[1]);
        // Five or more columns after a marker start indented code in the item.
        items.push(column - markerEnd > 4 ? markerEnd + 1 : column);
        rest = rest.slice(marker[0].length);
    }
    return { column, rest };
}

/**
 * Whether every code fence in a field's dedented continuation closes inside
 * the list item that opened it. Column 0 is the field's own content column.
 */
function fencesClose(continuation: ContinuationLine[]): boolean {
    // Content columns of the list items that contain the current line.
    const items = [0];
    let fence: { char: string; length: number; indent: number } | null = null;
    // Whether the previous line is paragraph text that the next line can
    // continue; the field line's own text is a paragraph.
    let paragraph = true;
    for (const { text, lazy } of continuation) {
        if (text === '') {
            paragraph = false;
            continue;
        }
        const indent = text.length - text.trimStart().length;
        if (fence) {
            // Unindented text inside a fence would end the enclosing list
            // item in Markdown, so it can never belong to the field.
            if (lazy || indent < fence.indent) return false;
            const closer = new RegExp(`^${fence.char}{${fence.length},}$`);
            if (indent - fence.indent < 4 && closer.test(text.slice(indent))) fence = null;
            continue;
        }
        // Text that continues a paragraph stays in that paragraph's list item
        // however little it is indented. This is judged from the text rather
        // than the reader's lazy flag, which serialization loses once it
        // indents a lazy line beneath the field's label.
        if (paragraph && (indent - items[items.length - 1] >= 4 || !startsBlock(text.slice(indent)))) continue;
        while (items.length > 1 && items[items.length - 1] > indent) items.pop();
        const { column, rest } = enterListItems(items, indent, text);
        const opener = FENCE_RE.exec(rest);
        const char = opener?.[1] ?? opener?.[2];
        const itemIndent = items[items.length - 1];
        const inItem = column - itemIndent < 4;
        if (char && inItem) fence = { char: char[0], length: char.length, indent: itemIndent };
        paragraph = !fence && inItem && isParagraphText(rest);
    }
    return fence === null;
}

/** Line-by-line reader for the field grammar documented above. */
class RecordFieldReader {
    private readonly fields = new Map<string, string>();
    private current: OpenField | null = null;

    constructor(private readonly allowedKeys?: ReadonlySet<string>) {}

    /** Consume one line; false means the record uses unsupported formatting. */
    read(rawLine: string): boolean {
        const line = expandStructuralTabs(rawLine).trimEnd();
        if (line === '') {
            this.current?.continuation.push({ text: '', lazy: false });
            return true;
        }
        if (/^ /.test(line)) return this.readIndented(line);

        const header = matchFieldHeader(line);
        if (header) {
            if (!this.finishField()) return false;
            this.current = { key: header.key, first: header.value, continuation: [] };
            return true;
        }
        if (THEMATIC_BREAK_RE.test(line)) return this.finishField();
        return this.readLazyContinuation(line);
    }

    /** Close the record, returning its fields or null when it is unsupported. */
    finish(): Map<string, string> | null {
        return this.finishField() ? this.fields : null;
    }

    private readIndented(line: string): boolean {
        if (!this.current) return false;
        this.current.continuation.push({ text: line, lazy: false });
        return true;
    }

    private readLazyContinuation(line: string): boolean {
        if (!this.current || BLOCK_START_RE.test(line)) return false;
        const { continuation } = this.current;
        // With no continuation yet, the previous line is the field line itself.
        if (continuation.length > 0) {
            const previous = continuation[continuation.length - 1].text.trim();
            if (previous === '' || HEADING_RE.test(previous)) return false;
        }
        continuation.push({ text: line, lazy: true });
        return true;
    }

    private finishField(): boolean {
        const field = this.current;
        if (!field) return true;
        if (this.fields.has(field.key) || (this.allowedKeys && !this.allowedKeys.has(field.key))) return false;
        const continuation = dedentContinuation(field);
        // A first line that serializers move below the label is published as
        // block content after a blank line, at the field's content column.
        // Its tabs expand at that column, as a continuation line's already
        // have, so fence checks and every later parse see the same nesting,
        // and a fence it opens must close in the field too.
        const belowLabel = field.first !== ''
            && startsBelowLabel(buildFieldValue(field.first, continuation).split('\n'));
        const first = belowLabel ? expandStructuralTabs(field.first) : field.first;
        const value = buildFieldValue(first, continuation);
        const published = belowLabel
            ? [{ text: '', lazy: false }, { text: first, lazy: false }, ...continuation]
            : continuation;
        if (!fencesClose(published)) return false;
        this.fields.set(field.key, value);
        this.current = null;
        return true;
    }
}

/**
 * Parse a record body into normalized field values, or null when it contains
 * content the field grammar above does not support. Duplicate fields are
 * rejected, as are fields outside `allowedKeys` when that set is supplied.
 */
export function extractRecordFields(block: string, allowedKeys?: ReadonlySet<string>): Map<string, string> | null {
    const reader = new RecordFieldReader(allowedKeys);
    for (const line of block.replace(/\r\n?/g, '\n').split('\n')) {
        if (!reader.read(line)) return null;
    }
    return reader.finish();
}

/**
 * Whether a multiline value starts on its own line below its label. That is
 * the case when its first line opens a block such as a numbered list, which
 * Markdown would otherwise fold into the label, or when inlining the first
 * line would change how the parser dedents the rest: an indented first line,
 * or later lines that all share indentation the parser would strip once they
 * are the only continuation.
 */
function startsBelowLabel(lines: string[]): boolean {
    if (lines.length < 2) return false;
    if (BLOCK_START_RE.test(lines[0]) || /^[ \t]/.test(lines[0])) return true;
    return lines.slice(1).every(line => line.trim() === '' || /^[ \t]/.test(line));
}

/**
 * Render one record field as a Markdown bullet. Continuation lines are
 * indented beneath the bullet, which keeps lists and paragraphs inside the
 * field when GitHub renders the comment and when the parser reads it back.
 * Values that `startsBelowLabel` start on their own line so Markdown does not
 * fold a leading block into the label and the parser dedents every line of
 * the value together.
 */
export function formatRecordField(label: string, value: string): string {
    const lines = value.split('\n');
    const leadsWithBlock = startsBelowLabel(lines);
    const header = leadsWithBlock ? `- **${label}:**` : `- **${label}:** ${lines.shift() ?? ''}`.trimEnd();
    const body = leadsWithBlock ? ['', ...lines] : lines;
    return [header, ...body.map(line => (line === '' ? '' : `  ${line}`))].join('\n');
}

/**
 * Render a record's fields. Single-line records stay compact; a record with
 * any multiline value separates its fields with blank lines for readability.
 */
export function formatRecordFields(fields: ReadonlyArray<readonly [label: string, value: string]>): string {
    const multiline = fields.some(([, value]) => value.includes('\n'));
    return fields.map(([label, value]) => formatRecordField(label, value)).join(multiline ? '\n\n' : '\n');
}
