/**
 * Jira's rich text (the Atlassian Document Format, ADF:
 * https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
 * as plain GitHub Markdown, for the description of the issue a ticket hands
 * over. Untrusted input: the result is text only.
 *
 * - Nothing is embedded: images and attachments (`media*`) become the words
 *   "(attachment not copied)", smart links and embeds (`inlineCard`,
 *   `blockCard`, `embedCard`) their URL as text, and a link its text followed
 *   by the URL. Only `http(s)://` URLs written with ordinary URL characters
 *   are kept; any other (`javascript:`, `data:`) is dropped.
 * - Nothing runs: macros and app content (`extension`, `bodiedExtension`,
 *   `inlineExtension` …) are left out entirely.
 * - Text cannot write Markdown: `\`, `` ` ``, `*`, `_`, `[`, `]`, `!`, `~`
 *   and `|` in it are backslash-escaped, so ticket text never forms an image,
 *   a link or a table. Structure (headings, lists, quotes, code, tables)
 *   comes from the document's nodes only. The caller quotes the result and
 *   writes `&`, `<` and `>` as entities (`inertQuote`), so no HTML either.
 * - Bounded: at most `ADF_LIMITS.depth` levels and `ADF_LIMITS.nodes` nodes
 *   are read, and the result is cut at `ADF_LIMITS.chars` characters.
 */

export const ADF_LIMITS = { depth: 24, nodes: 20_000, chars: 60_000 } as const;

interface AdfNode { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown; marks?: unknown }
type Attrs = Record<string, unknown>;

const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]{1,2000}$/;
/** A URL kept as text: `http(s)://` and ordinary URL characters only (no brackets, parentheses, quotes or spaces). */
export const safeUrl = (value: unknown): string | null => (typeof value === 'string' && SAFE_URL.test(value) ? value : null);

/** Ticket text with every character Markdown could read as syntax escaped. */
export const escapeMarkdown = (text: string): string => text.replace(/[\\`*_[\]!~|]/g, '\\$&');

const isNode = (value: unknown): value is AdfNode => !!value && typeof value === 'object' && !Array.isArray(value);
const attrsOf = (node: AdfNode): Attrs => (isNode(node.attrs) ? node.attrs as Attrs : {});
const children = (node: AdfNode): AdfNode[] => (Array.isArray(node.content) ? node.content.filter(isNode) : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Node types whose content is never copied: macros and app content. */
const LEFT_OUT = new Set(['extension', 'bodiedExtension', 'inlineExtension', 'multiBodiedExtension', 'extensionFrame', 'placeholder']);
const MEDIA = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);
const CARDS = new Set(['inlineCard', 'blockCard', 'embedCard']);
const ATTACHMENT = '(attachment not copied)';

/** A code span or fence for `text`: longer than any backtick run inside it. */
function fence(text: string, min: number): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  return '`'.repeat(Math.max(min, longest + 1));
}

class Converter {
  private nodes = 0;

  private visit(depth: number): boolean {
    this.nodes += 1;
    return depth <= ADF_LIMITS.depth && this.nodes <= ADF_LIMITS.nodes;
  }

  /** Inline content (text, marks, mentions, cards) on one or more lines. */
  inline(nodes: AdfNode[], depth: number): string {
    return nodes.map(node => this.inlineNode(node, depth)).join('');
  }

  private inlineNode(node: AdfNode, depth: number): string {
    if (!this.visit(depth)) return '';
    const attrs = attrsOf(node);
    switch (node.type) {
      case 'text': return this.marked(str(node.text), node.marks);
      case 'hardBreak': return '\n';
      case 'mention': return escapeMarkdown(str(attrs.text) || '@someone');
      case 'emoji': return escapeMarkdown(str(attrs.text) || str(attrs.shortName));
      case 'status': return escapeMarkdown(str(attrs.text));
      case 'date': {
        const time = Number(attrs.timestamp);
        return Number.isFinite(time) && Math.abs(time) < 8.64e15 ? new Date(time).toISOString().slice(0, 10) : '';
      }
      default:
        if (CARDS.has(String(node.type))) return safeUrl(attrs.url) ?? '';
        if (MEDIA.has(String(node.type))) return ATTACHMENT;
        if (LEFT_OUT.has(String(node.type))) return '';
        return this.inline(children(node), depth + 1);
    }
  }

  /** A text node with its marks: emphasis kept, a link as its text and URL, colours and the like dropped. */
  private marked(text: string, marks: unknown): string {
    const list = Array.isArray(marks) ? marks.filter(isNode) : [];
    const has = (type: string) => list.some(mark => mark.type === type);
    if (!text) return '';
    let out: string;
    if (has('code')) {
      const tick = fence(text, 1);
      const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
      out = `${tick}${pad}${text.replace(/\n/g, ' ')}${pad}${tick}`;
    } else {
      out = escapeMarkdown(text);
      // Emphasis around the text, not its surrounding spaces (Markdown would not read `** a **`).
      const wrap = (marker: string) => { out = out.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_m, lead: string, core: string, tail: string) => (core ? `${lead}${marker}${core}${marker}${tail}` : `${lead}${tail}`)); };
      if (has('strong')) wrap('**');
      if (has('em')) wrap('_');
      if (has('strike')) wrap('~~');
    }
    const link = list.find(mark => mark.type === 'link');
    const href = link ? safeUrl(attrsOf(link).href) : null;
    return href && href !== text ? `${out} (${href})` : out;
  }

  /** Block content, blocks separated by a blank line. */
  blocks(nodes: AdfNode[], depth: number): string {
    return nodes.map(node => this.block(node, depth)).filter(Boolean).join('\n\n');
  }

  private block(node: AdfNode, depth: number): string {
    if (!this.visit(depth)) return '';
    const attrs = attrsOf(node);
    const type = String(node.type);
    switch (type) {
      case 'paragraph': return this.inline(children(node), depth + 1).trim();
      case 'heading': {
        const level = Math.min(6, Math.max(1, Math.trunc(Number(attrs.level)) || 1));
        const text = this.inline(children(node), depth + 1).replace(/\s*\n\s*/g, ' ').trim();
        return text ? `${'#'.repeat(level)} ${text}` : '';
      }
      case 'bulletList': return this.list(children(node), depth, () => '- ');
      case 'orderedList': {
        const start = Math.max(0, Math.min(1e6, Math.trunc(Number(attrs.order)) || 1));
        return this.list(children(node), depth, index => `${start + index}. `);
      }
      case 'taskList': return this.list(children(node), depth, (_index, item) => (attrsOf(item).state === 'DONE' ? '- [x] ' : '- [ ] '));
      case 'decisionList': return this.list(children(node), depth, () => '- ');
      case 'blockquote': return prefixLines(this.blocks(children(node), depth + 1), '> ');
      case 'codeBlock': {
        const text = children(node).map(child => str(child.text)).join('');
        const language = typeof attrs.language === 'string' && /^[A-Za-z0-9_+.-]{1,30}$/.test(attrs.language) ? attrs.language : '';
        const tick = fence(text, 3);
        return `${tick}${language}\n${text.replace(/\n+$/, '')}\n${tick}`;
      }
      case 'rule': return '---';
      case 'table': return this.table(children(node), depth);
      case 'expand': case 'nestedExpand': {
        const title = typeof attrs.title === 'string' && attrs.title.trim() ? `**${escapeMarkdown(attrs.title.trim())}**` : '';
        return [title, this.blocks(children(node), depth + 1)].filter(Boolean).join('\n\n');
      }
      case 'mediaSingle': case 'mediaGroup': case 'media': return ATTACHMENT;
      case 'blockCard': case 'embedCard': return safeUrl(attrs.url) ?? '';
      default: {
        if (LEFT_OUT.has(type)) return '';
        const content = children(node);
        // Inline content where a block was expected (a task or decision item), or an unknown container (panel, layout).
        if (content.length && content.every(child => child.type === 'text' || child.type === 'hardBreak' || child.type === 'mention' || child.type === 'emoji' || child.type === 'inlineCard' || child.type === 'date' || child.type === 'status')) {
          return this.inline(content, depth + 1).trim();
        }
        return this.blocks(content, depth + 1);
      }
    }
  }

  private list(items: AdfNode[], depth: number, marker: (index: number, item: AdfNode) => string): string {
    return items.map((item, index) => {
      const lead = marker(index, item);
      // An item's content: blocks (a list item) or inline content (a task or decision item).
      const body = this.block({ content: item.content, type: 'listContent' }, depth + 1);
      const lines = body.split('\n');
      return [`${lead}${lines[0]}`, ...lines.slice(1).map(line => (line ? `${' '.repeat(lead.length)}${line}` : ''))].join('\n');
    }).join('\n');
  }

  private table(rows: AdfNode[], depth: number): string {
    const cells = rows.map(row => children(row).map(cell => this.blocks(children(cell), depth + 2).replace(/\s*\n+\s*/g, ' ').trim()));
    const width = Math.max(0, ...cells.map(row => row.length));
    if (!width) return '';
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_v, i) => row[i] ?? '').join(' | ')} |`;
    return [line(cells[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
  }
}

const prefixLines = (text: string, prefix: string) => (text ? text.split('\n').map(line => (line ? `${prefix}${line}` : prefix.trimEnd())).join('\n') : '');

/**
 * A Jira description as Markdown: an ADF document converted (see above), a
 * plain string (an older API's text) escaped, anything else empty.
 */
export function adfToMarkdown(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = escapeMarkdown(value);
  else if (isNode(value) && value.type === 'doc') text = new Converter().blocks(children(value), 1);
  else text = '';
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > ADF_LIMITS.chars ? `${text.slice(0, ADF_LIMITS.chars)}…` : text;
}

/** An ADF document of ProPR's own comment: a sentence, an optional link, and who posted it. */
export function adfComment(sentence: string, link: { label: string; url: string } | null): Record<string, unknown> {
  const first: Record<string, unknown>[] = [{ type: 'text', text: sentence }];
  if (link) first.push({ type: 'text', text: ' ' }, { type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.url } }] });
  return {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: first },
      { type: 'paragraph', content: [{ type: 'text', text: 'Posted by ProPR.', marks: [{ type: 'em' }] }] },
    ],
  };
}
