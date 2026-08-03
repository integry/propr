import { describe, expect, it } from 'vitest';
import { resolveSyntaxLanguage } from './syntaxHighlighter';

describe('resolveSyntaxLanguage', () => {
  it('resolves registered languages and common fenced-code aliases', () => {
    expect(resolveSyntaxLanguage('ini')).toBe('ini');
    expect(resolveSyntaxLanguage(' JSONC ')).toBe('json');
    expect(resolveSyntaxLanguage('xml')).toBe('markup');
    expect(resolveSyntaxLanguage('c++')).toBe('cpp');
  });

  it('renders plain and unknown language names without Prism highlighting', () => {
    expect(resolveSyntaxLanguage('text')).toBe('text');
    expect(resolveSyntaxLanguage('plaintext')).toBe('text');
    expect(resolveSyntaxLanguage('future-language')).toBe('text');
  });
});
