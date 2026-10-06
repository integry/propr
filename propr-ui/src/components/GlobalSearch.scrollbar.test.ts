import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const indexStyles = read('src/index.css');

const ruleFor = (selector: string): string => {
  const start = indexStyles.search(new RegExp(`\\n\\s*${selector.replace(/[.:()-]/g, '\\$&')} \\{`));
  if (start < 0) return '';
  const bodyStart = indexStyles.indexOf('{', start) + 1;
  const end = indexStyles.indexOf('}', bodyStart);
  return indexStyles.slice(bodyStart, end);
};

describe('search palette stealth scrollbars', () => {
  it('only sets the standard properties where WebKit scrollbar styling is unsupported', () => {
    // Chromium ignores ::-webkit-scrollbar rules, including the hidden stepper buttons, once these are set.
    const fallback = indexStyles.match(/@supports not selector\(::-webkit-scrollbar\) \{\s*\.scrollbar-subtle \{/);
    expect(fallback).not.toBeNull();
  });

  it('hides the scrollbar thumb at rest in both standard and WebKit styling', () => {
    expect(ruleFor('.scrollbar-subtle')).toMatch(/scrollbar-color:\s*transparent transparent;/);
    expect(ruleFor('.scrollbar-subtle::-webkit-scrollbar-thumb')).toMatch(/background:\s*transparent;/);
  });

  it('reveals the thumb only while the container is hovered', () => {
    expect(ruleFor('.scrollbar-subtle:hover')).toMatch(/scrollbar-color:\s*#cbd5e1 transparent;/);
    expect(ruleFor('.scrollbar-subtle:hover::-webkit-scrollbar-thumb')).toMatch(/background:\s*#cbd5e1;/);
  });

  it('keeps the narrow width and hides stepper buttons', () => {
    expect(ruleFor('.scrollbar-subtle')).toMatch(/scrollbar-width:\s*thin;/);
    expect(ruleFor('.scrollbar-subtle::-webkit-scrollbar')).toMatch(/width:\s*6px;/);
    expect(indexStyles).toMatch(/\.scrollbar-subtle::-webkit-scrollbar-button\s*\{[^}]*display:\s*none;/);
  });

  it('applies the stealth utility to the results list and the preview pane', () => {
    expect(read('src/components/GlobalSearch.tsx')).toMatch(/ref=\{listRef\}[^>]*scrollbar-subtle/);
    expect(read('src/components/GlobalSearchResults.tsx')).toMatch(/overflow-y-auto[^"]*scrollbar-subtle/);
  });
});
