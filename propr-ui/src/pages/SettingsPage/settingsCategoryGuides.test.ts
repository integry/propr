import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { SETTINGS_CATEGORIES } from './SettingsNavigation';
import { SETTINGS_CATEGORY_GUIDES } from './settingsCategoryGuides';

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

describe('settings category guides', () => {
  test('cover every category', () => {
    expect(Object.keys(SETTINGS_CATEGORY_GUIDES).sort()).toEqual(SETTINGS_CATEGORIES.map(category => category.id).sort());
  });

  const links = Object.entries(SETTINGS_CATEGORY_GUIDES)
    .flatMap(([category, guide]) => guide.links.map(link => [category, link.href] as const));

  test.each(links)('%s links to an existing docs page and heading: %s', (_category, href) => {
    expect(href.startsWith(DOCS_URL)).toBe(true);
    const [page, anchor] = href.slice(DOCS_URL.length).split('#');
    const file = path.join(DOCS_ROOT, `${page}.md`);
    expect(existsSync(file), `${file} is missing`).toBe(true);
    if (anchor) expect([...anchorsIn(readFileSync(file, 'utf8'))]).toContain(anchor);
  });
});
