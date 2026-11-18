/**
 * Timestamps reach the screen through `utils/dateFormat.ts` only. This guard reads every
 * source file so a new `toLocaleString()` / `toLocaleDateString()` / `toLocaleTimeString()`
 * on a date — locale-default output that differs page to page — fails the suite.
 * Number formatting (`count.toLocaleString()`) is not a timestamp and stays allowed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');
const FORMATTER = 'utils/dateFormat.ts';

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
  const path = join(dir, entry);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
});

/** Direct date-to-text conversions that bypass the shared formatter. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['toLocaleDateString()', /\.toLocaleDateString\(/],
  ['toLocaleTimeString()', /\.toLocaleTimeString\(/],
  ['new Date(…).toLocaleString()', /new Date\([^;]*?\)\.toLocaleString\(/],
  ['<date>.toLocaleString()', /(?:[dD]ate|[tT]ime|[tT]imestamp|[a-z]At)\)?\.toLocaleString\(/],
  ['Intl.DateTimeFormat', /Intl\.DateTimeFormat\((?!\)\.resolvedOptions)/],
];

export const findDateFormattingViolations = (text: string): string[] =>
  text.split('\n').flatMap((line, index) =>
    FORBIDDEN.filter(([, pattern]) => pattern.test(line)).slice(0, 1).map(([name]) => `${index + 1}: ${name}`));

describe('timestamp formatting', () => {
  it('flags the direct conversions it is meant to catch', () => {
    expect(findDateFormattingViolations('new Date(at).toLocaleString()')).toHaveLength(1);
    expect(findDateFormattingViolations('date.toLocaleDateString()')).toHaveLength(1);
    expect(findDateFormattingViolations('updatedAt.toLocaleString()')).toHaveLength(1);
    expect(findDateFormattingViolations('count.toLocaleString()')).toHaveLength(0);
    expect(findDateFormattingViolations('Intl.DateTimeFormat().resolvedOptions().timeZone')).toHaveLength(0);
  });

  it('uses the shared formatter for every timestamp outside utils/dateFormat.ts', () => {
    const violations = sourceFiles(SRC)
      .map(path => relative(SRC, path).split('\\').join('/'))
      .filter(path => path !== FORMATTER)
      .flatMap(path => findDateFormattingViolations(readFileSync(join(SRC, path), 'utf8')).map(v => `${path}:${v}`));
    expect(violations).toEqual([]);
  });
});
