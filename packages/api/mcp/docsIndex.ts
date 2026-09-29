/* eslint-disable max-lines -- Discovery, normalization, chunking and search share one deliberately MCP-agnostic index module. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import packageInfo from '../package.json' with { type: 'json' };
import { redact } from './adapter.js';

const MAX_DOC_BYTES = 512 * 1024;
const REFRESH_INTERVAL_MS = 60_000;
const EXTRA_GUIDES = new Map([
  ['mcp.md', 'mcp/guide'],
  ['mcp-coverage.md', 'mcp/coverage'],
  ['mcp-operator-surface.md', 'mcp/operator-surface'],
]);

export interface DocOutlineEntry { level: number; heading: string; offset: number }
export interface DocPageSummary { path: string; title: string; section: string; summary: string; words: number }
export interface IndexedDocPage extends DocPageSummary {
  content: string;
  outline: DocOutlineEntry[];
  sidebarPosition: number | null;
}
export interface DocsIndex {
  root: string;
  docsVersion: string;
  sourceRevision: string | null;
  pages: IndexedDocPage[];
  byPath: ReadonlyMap<string, IndexedDocPage>;
}
export interface DocSectionLocator { heading: string; offset: number }
export interface GetDocOptions { offset?: number; maxChars?: number; section?: string | DocSectionLocator }
export interface SearchResult {
  path: string; title: string; heading: string; section: DocSectionLocator | null; snippet: string; score: number;
}

/** Domain errors are translated to the public MCP envelope by toolsDocs.ts. */
export class DocsIndexError extends Error {
  constructor(public readonly code: 'DOCS_UNAVAILABLE' | 'DOC_NOT_FOUND' | 'SECTION_NOT_FOUND', message: string) {
    super(message);
    this.name = 'DocsIndexError';
  }
}

interface Candidate { file: string; path: string; signature: string }
interface Inventory { candidates: Candidate[]; fingerprint: string; manifestFile: string | null }
interface Manifest { version?: string; sourceRevision?: string | null; order?: string[] }
interface CacheEntry { root: string; fingerprint: string; checkedAt: number; index: DocsIndex }

let cached: CacheEntry | undefined;
let building: { root: string; promise: Promise<CacheEntry> } | undefined;

async function directoryCandidate(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? path : null;
  } catch {
    return null;
  }
}

/** Resolve the first real directory in the documented operator precedence. */
export async function resolveDocsRoot(
  env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
): Promise<string | null> {
  const candidates = [env.PROPR_DOCS_DIR, resolve(cwd, 'docs'), '/app/docs']
    .filter((value): value is string => Boolean(value))
    .map(value => resolve(value));
  for (const candidate of [...new Set(candidates)]) {
    const directory = await directoryCandidate(candidate);
    if (directory) return directory;
  }
  return null;
}

async function walkDocs(directory: string, relative: string, inventory: Inventory): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = join(directory, entry.name);
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkDocs(file, child, inventory);
      continue;
    }
    if (!entry.isFile() || !/\.mdx?$/i.test(entry.name)) continue;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DOC_BYTES) continue;
    inventory.candidates.push({
      file,
      path: child.replace(/\.mdx?$/i, ''),
      signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    });
  }
}

async function addOptionalFile(root: string, name: string, inventory: Inventory): Promise<void> {
  const file = join(root, name);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DOC_BYTES) return;
    const path = EXTRA_GUIDES.get(name);
    if (path) inventory.candidates.push({
      file, path, signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    });
  } catch {
    // Optional operator guide.
  }
}

async function inventoryRoot(root: string): Promise<Inventory> {
  const inventory: Inventory = { candidates: [], fingerprint: '', manifestFile: null };
  const pagesRoot = join(root, 'docs');
  const pagesInfo = await directoryCandidate(pagesRoot);
  if (pagesInfo) await walkDocs(pagesRoot, '', inventory);
  for (const name of EXTRA_GUIDES.keys()) await addOptionalFile(root, name, inventory);
  const manifestFile = join(root, 'docs-manifest.json');
  let manifestSignature = '';
  try {
    const info = await lstat(manifestFile);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_DOC_BYTES) {
      inventory.manifestFile = manifestFile;
      manifestSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    }
  } catch {
    // The source checkout does not have a generated manifest.
  }
  inventory.candidates.sort((left, right) => left.path.localeCompare(right.path) || left.file.localeCompare(right.file));
  inventory.fingerprint = [
    ...inventory.candidates.map(candidate => `${candidate.path}\0${candidate.file}\0${candidate.signature}`),
    `manifest\0${manifestSignature}`,
  ].join('\n');
  return inventory;
}

/** Read an already-discovered file without ever following a symlink. */
async function readDiscoveredFile(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_DOC_BYTES) return null;
    const data = await handle.readFile();
    return data.byteLength <= MAX_DOC_BYTES ? data.toString('utf8') : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function splitFrontMatter(source: string): { body: string; title?: string; sidebarPosition: number | null } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { body: source.replace(/^\uFEFF/, ''), sidebarPosition: null };
  const metadata = match[1];
  const titleMatch = /^title:\s*(.*?)\s*$/m.exec(metadata);
  const positionMatch = /^sidebar_position:\s*(-?\d+(?:\.\d+)?)\s*$/m.exec(metadata);
  let title = titleMatch?.[1]?.trim();
  if (title && ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("'") && title.endsWith("'")))) {
    title = title.slice(1, -1);
  }
  const position = positionMatch ? Number(positionMatch[1]) : Number.NaN;
  return { body: source.slice(match[0].length), ...(title ? { title } : {}), sidebarPosition: Number.isFinite(position) ? position : null };
}

interface SourceLine { text: string; offset: number }

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ text: match[0], offset: match.index });
  }
  return lines;
}

function fenceToken(line: string): string | null {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
}

function stripMdxComments(line: string, insideComment: boolean): { text: string; insideComment: boolean } {
  let cursor = 0;
  let output = '';
  while (cursor < line.length) {
    if (insideComment) {
      const end = line.indexOf('*/}', cursor);
      if (end < 0) return { text: output, insideComment: true };
      cursor = end + 3;
      insideComment = false;
    } else {
      const start = line.indexOf('{/*', cursor);
      if (start < 0) return { text: output + line.slice(cursor), insideComment: false };
      output += line.slice(cursor, start);
      cursor = start + 3;
      insideComment = true;
    }
  }
  return { text: output, insideComment };
}

/** Strip Docusaurus-only wrappers while leaving fenced code byte-for-byte intact. */
export function normalizeDocContent(source: string): { content: string; title?: string; sidebarPosition: number | null } {
  const frontMatter = splitFrontMatter(source);
  let fence: string | null = null;
  let insideComment = false;
  let content = '';
  for (const { text } of sourceLines(frontMatter.body)) {
    const token = fenceToken(text);
    if (fence) {
      content += text;
      if (token?.[0] === fence[0] && token.length >= fence.length) fence = null;
      continue;
    }
    if (token) {
      fence = token;
      content += text;
      continue;
    }
    const stripped = stripMdxComments(text, insideComment);
    insideComment = stripped.insideComment;
    if (/^\s*import\b.*\bfrom\s+['"][^'"]+['"]\s*;?\s*(?:\r\n|\r|\n)?$/.test(stripped.text)) continue;
    content += stripped.text;
  }
  return { content, ...(frontMatter.title ? { title: frontMatter.title } : {}), sidebarPosition: frontMatter.sidebarPosition };
}

function plainHeading(markdown: string): string {
  return markdown
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/[ \t]+\{#[^}]+\}[ \t]*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .trim();
}

export function docOutline(content: string): DocOutlineEntry[] {
  const outline: DocOutlineEntry[] = [];
  let fence: string | null = null;
  for (const line of sourceLines(content)) {
    const token = fenceToken(line.text);
    if (fence) {
      if (token?.[0] === fence[0] && token.length >= fence.length) fence = null;
      continue;
    }
    if (token) { fence = token; continue; }
    const match = /^ {0,3}(#{1,6})[ \t]+([^\r\n]+?)(?:\r\n|\r|\n)?$/.exec(line.text);
    if (!match) continue;
    const heading = plainHeading(match[2]);
    if (heading) outline.push({ level: match[1].length, heading, offset: line.offset });
  }
  return outline;
}

function fallbackTitle(path: string): string {
  return basename(path).split(/[-_]/).filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function summaryText(content: string, outline: DocOutlineEntry[]): string {
  const firstTitle = outline.find(item => item.level === 1);
  const titleEnd = firstTitle ? content.indexOf('\n', firstTitle.offset) + 1 : 0;
  const afterTitle = content.slice(Math.max(0, titleEnd));
  const blocks = afterTitle.split(/(?:\r?\n){2,}/);
  const paragraph = blocks.find(block => {
    const trimmed = block.trim();
    return Boolean(trimmed) && !/^(?:#{1,6}\s|```|~~~|\||[-*+]\s|\d+[.)]\s)/.test(trimmed);
  });
  if (!paragraph) return '';
  const plain = paragraph
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= 240 ? plain : `${plain.slice(0, 237).trimEnd()}...`;
}

function wordCount(content: string): number {
  return content.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

async function readManifest(file: string | null): Promise<Manifest | null> {
  if (!file) return null;
  const source = await readDiscoveredFile(file);
  if (!source) return null;
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    return {
      ...(typeof value.version === 'string' && value.version ? { version: value.version } : {}),
      ...(typeof value.sourceRevision === 'string' || value.sourceRevision === null ? { sourceRevision: value.sourceRevision as string | null } : {}),
      ...(Array.isArray(value.order) && value.order.every(item => typeof item === 'string') ? { order: value.order as string[] } : {}),
    };
  } catch {
    return null;
  }
}

async function buildIndex(root: string, inventory: Inventory): Promise<DocsIndex> {
  const manifest = await readManifest(inventory.manifestFile);
  const pages: IndexedDocPage[] = [];
  const seen = new Set<string>();
  for (const candidate of inventory.candidates) {
    if (seen.has(candidate.path)) continue;
    const source = await readDiscoveredFile(candidate.file);
    if (source === null) continue;
    const normalized = normalizeDocContent(source);
    // Redact the complete normalized page before deriving any positions or
    // bounded views. Otherwise pagination can split a credential so the
    // dispatch-level safeguard no longer recognizes either fragment.
    const content = redact(normalized.content) as string;
    const outline = docOutline(content);
    const title = normalized.title ?? outline.find(item => item.level === 1)?.heading ?? fallbackTitle(candidate.path);
    pages.push({
      path: candidate.path,
      title,
      section: candidate.path.split('/')[0],
      summary: summaryText(content, outline),
      words: wordCount(content),
      content,
      outline,
      sidebarPosition: normalized.sidebarPosition,
    });
    seen.add(candidate.path);
  }
  const order = new Map((manifest?.order ?? []).map((path, index) => [path, index]));
  pages.sort((left, right) => {
    if (order.size) {
      const leftOrder = order.get(left.path);
      const rightOrder = order.get(right.path);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        return leftOrder - rightOrder;
      }
    }
    if (left.sidebarPosition !== right.sidebarPosition) {
      if (left.sidebarPosition === null) return 1;
      if (right.sidebarPosition === null) return -1;
      return left.sidebarPosition - right.sidebarPosition;
    }
    return left.path.localeCompare(right.path);
  });
  return {
    root,
    docsVersion: manifest?.version ?? packageInfo.version,
    sourceRevision: manifest?.sourceRevision ?? null,
    pages,
    byPath: new Map(pages.map(page => [page.path, page])),
  };
}

async function buildCache(root: string, inventory?: Inventory): Promise<CacheEntry> {
  const discovered = inventory ?? await inventoryRoot(root);
  const index = await buildIndex(root, discovered);
  return { root, fingerprint: discovered.fingerprint, checkedAt: Date.now(), index };
}

/** Load the lazy singleton index, refreshing its inventory no more than once a minute. */
export async function loadDocsIndex(): Promise<DocsIndex> {
  const root = await resolveDocsRoot();
  if (!root) throw new DocsIndexError('DOCS_UNAVAILABLE', 'Documentation is unavailable. Run an image that bundles docs or set PROPR_DOCS_DIR to the documentation root.');
  if (cached?.root === root && Date.now() - cached.checkedAt < REFRESH_INTERVAL_MS) return cached.index;
  if (building?.root === root) return (await building.promise).index;
  const promise = (async () => {
    try {
      const inventory = await inventoryRoot(root);
      if (cached?.root === root && cached.fingerprint === inventory.fingerprint) {
        cached.checkedAt = Date.now();
        return cached;
      }
      return await buildCache(root, inventory);
    } catch {
      throw new DocsIndexError('DOCS_UNAVAILABLE', 'Documentation is unavailable. Run an image that bundles docs or set PROPR_DOCS_DIR to the documentation root.');
    }
  })();
  building = { root, promise };
  try {
    cached = await promise;
    return cached.index;
  } finally {
    if (building?.promise === promise) building = undefined;
  }
}

export function listIndexedDocs(index: DocsIndex, options: { section?: string; offset: number; limit: number }): {
  docsVersion: string; pages: DocPageSummary[]; nextOffset: number | null;
} {
  const matching = options.section
    ? index.pages.filter(page => page.section.toLocaleLowerCase() === options.section!.toLocaleLowerCase())
    : index.pages;
  const pages = matching.slice(options.offset, options.offset + options.limit)
    .map(({ path, title, section, summary, words }) => ({ path, title, section, summary, words }));
  return { docsVersion: index.docsVersion, pages, nextOffset: options.offset + pages.length < matching.length ? options.offset + pages.length : null };
}

function paragraphChunk(content: string, offset: number, maxChars: number, end = content.length): { content: string; nextOffset: number | null } {
  const start = Math.min(Math.max(0, offset), end);
  const hardEnd = Math.min(start + maxChars, end);
  if (hardEnd === end) return { content: content.slice(start, end), nextOffset: null };
  let chunkEnd = hardEnd;
  for (const match of content.slice(start, hardEnd).matchAll(/(?:\r?\n){2}/g)) {
    if (match.index > 0) chunkEnd = start + match.index + match[0].length;
  }
  return { content: content.slice(start, chunkEnd), nextOffset: chunkEnd };
}

function sectionRange(page: IndexedDocPage, requested: string | DocSectionLocator): { start: number; end: number } {
  const index = typeof requested === 'string'
    ? page.outline.findIndex(item => item.heading.toLocaleLowerCase() === requested.trim().toLocaleLowerCase())
    : page.outline.findIndex(item => item.offset === requested.offset && item.heading === requested.heading);
  if (index < 0) throw new DocsIndexError('SECTION_NOT_FOUND', `Heading not found in ${page.path}.`);
  const heading = page.outline[index];
  const next = page.outline.slice(index + 1).find(item => item.level <= heading.level);
  return { start: heading.offset, end: next?.offset ?? page.content.length };
}

export function getIndexedDoc(index: DocsIndex, path: string, options: GetDocOptions = {}): {
  path: string; title: string; docsVersion: string; outline: DocOutlineEntry[]; content: string;
  offset: number; nextOffset: number | null; totalChars: number;
} {
  const page = index.byPath.get(path);
  if (!page) throw new DocsIndexError('DOC_NOT_FOUND', 'Documentation page not found. Use list_docs or search_docs to select a valid path.');
  const maxChars = options.maxChars ?? 8000;
  let offset = options.offset ?? 0;
  let end = page.content.length;
  if (options.section) {
    const range = sectionRange(page, options.section);
    end = range.end;
    offset = offset === 0 ? range.start : Math.max(range.start, offset);
  }
  offset = Math.min(offset, end);
  const chunk = paragraphChunk(page.content, offset, maxChars, end);
  return {
    path: page.path, title: page.title, docsVersion: index.docsVersion, outline: page.outline,
    content: chunk.content, offset, nextOffset: chunk.nextOffset, totalChars: page.content.length,
  };
}

function searchSnippet(body: string, terms: string[], fallback: string): string {
  const compact = body.replace(/\s+/g, ' ').trim() || fallback;
  const lower = compact.toLocaleLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0);
  const match = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, match - 100);
  const end = Math.min(compact.length, start + 300);
  if (end - start < 300) start = Math.max(0, end - 300);
  let snippet = compact.slice(start, end);
  if (start > 0) snippet = `…${snippet.slice(1)}`;
  if (end < compact.length) snippet = `${snippet.slice(0, -1)}…`;
  return snippet;
}

interface SearchSegment {
  heading: string; headingOffset: number; section: DocSectionLocator | null; body: string; titleSegment: boolean;
}

function searchSegments(page: IndexedDocPage): SearchSegment[] {
  if (!page.outline.length) {
    return [{ heading: page.title, headingOffset: 0, section: null, body: page.content, titleSegment: true }];
  }
  const introductoryBody = page.content.slice(0, page.outline[0].offset);
  const hasIntroduction = Boolean(introductoryBody.trim());
  const segments: SearchSegment[] = page.outline.map((heading, index) => {
    const lineEnd = page.content.indexOf('\n', heading.offset);
    const bodyStart = lineEnd < 0 ? page.content.length : lineEnd + 1;
    return {
      heading: heading.heading,
      headingOffset: heading.offset,
      section: { heading: heading.heading, offset: heading.offset },
      body: page.content.slice(bodyStart, page.outline[index + 1]?.offset ?? page.content.length),
      titleSegment: !hasIntroduction
        && (index === 0 || heading.heading.toLocaleLowerCase() === page.title.toLocaleLowerCase()),
    };
  });
  if (hasIntroduction) {
    segments.unshift({
      heading: page.title, headingOffset: 0, section: null, body: introductoryBody, titleSegment: true,
    });
  }
  return segments;
}

/** Search independently-scored page/heading groups and return exact locators for real headings. */
export function searchIndexedDocs(index: DocsIndex, query: string, limit: number): { results: SearchResult[] } {
  const terms = [...new Set(query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean))];
  const ranked: Array<SearchResult & { pageOrder: number; headingOffset: number }> = [];
  index.pages.forEach((page, pageOrder) => {
    for (const segment of searchSegments(page)) {
      const title = page.title.toLocaleLowerCase();
      const heading = segment.heading.toLocaleLowerCase();
      const body = segment.body.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total
        + (segment.titleSegment && title.includes(term) ? 5 : 0)
        + (heading.includes(term) ? 3 : 0)
        + (body.includes(term) ? 1 : 0), 0);
      if (!score) continue;
      ranked.push({
        path: page.path, title: page.title, heading: segment.heading, section: segment.section,
        snippet: searchSnippet(segment.body, terms, segment.heading), score, pageOrder, headingOffset: segment.headingOffset,
      });
    }
  });
  ranked.sort((left, right) => right.score - left.score || left.pageOrder - right.pageOrder || left.headingOffset - right.headingOffset);
  return { results: ranked.slice(0, limit).map(result => ({
    path: result.path, title: result.title, heading: result.heading, section: result.section,
    snippet: result.snippet, score: result.score,
  })) };
}
