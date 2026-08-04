import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveSyntaxLanguage, SyntaxHighlighter } from './syntaxHighlighter';

describe('resolveSyntaxLanguage', () => {
  it('resolves registered languages and common fenced-code aliases', () => {
    expect(resolveSyntaxLanguage('ini')).toBe('ini');
    expect(resolveSyntaxLanguage(' JSONC ')).toBe('json');
    expect(resolveSyntaxLanguage('xml')).toBe('markup');
    expect(resolveSyntaxLanguage('c++')).toBe('cpp');
    expect(resolveSyntaxLanguage('dockerfile')).toBe('docker');
  });

  it('renders plain and unknown language names without Prism highlighting', () => {
    expect(resolveSyntaxLanguage('text')).toBe('text');
    expect(resolveSyntaxLanguage('plaintext')).toBe('text');
    expect(resolveSyntaxLanguage('future-language')).toBe('text');
  });

  it('renders unknown languages through the Prism light text fallback', () => {
    const markup = renderToStaticMarkup(createElement(SyntaxHighlighter, {
      language: resolveSyntaxLanguage('future-language'),
      children: 'unregistered output',
    }));

    expect(markup).toContain('unregistered output');
  });
});
