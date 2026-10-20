import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

const DOCS_ROOT = path.resolve(__dirname, '../../../../docs/docs');
const DOCS_URL = 'https://docs.propr.dev/docs/';

/** Heading anchors as Docusaurus generates them, plus explicit `{#id}`s. */
function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading] of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const explicit = heading.match(/\{#([\w-]+)\}\s*$/);
    anchors.add(explicit
      ? explicit[1]
      : heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-'));
  }
  return anchors;
}

/** Asserts that a docs.propr.dev href names a page, and heading, in the docs tree. */
export function expectExistingDocsRoute(href: string | null): void {
  expect(href?.startsWith(DOCS_URL), `${href} is not a docs link`).toBe(true);
  const [page, anchor] = href!.slice(DOCS_URL.length).split('#');
  const file = path.join(DOCS_ROOT, `${page}.md`);
  expect(existsSync(file), `${file} is missing`).toBe(true);
  if (anchor) expect([...anchorsIn(readFileSync(file, 'utf8'))]).toContain(anchor);
}
