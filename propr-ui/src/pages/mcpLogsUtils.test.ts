import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE,
  buildMcpLogQuery,
  clientDisplayName,
  formatMcpBytes,
  formatMcpCount,
  formatMcpDuration,
  hasActiveMcpLogFilters,
  outcomeTone,
  parseMcpLogFilters,
  resolveWindowSince,
} from './mcpLogsUtils';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

describe('parseMcpLogFilters', () => {
  it('reads a shared URL back into the same filter set', () => {
    const filters = parseMcpLogFilters(new URLSearchParams(
      'window=7d&outcome=denied&kind=resource&name=repo_tree&repository=integry/propr&client=client-a&user=42'
    ));

    expect(filters).toEqual({
      window: '7d',
      outcome: 'denied',
      kind: 'resource',
      name: 'repo_tree',
      repository: 'integry/propr',
      client: 'client-a',
      user: '42',
    });
    expect(hasActiveMcpLogFilters(filters)).toBe(true);
  });

  it('falls back to the default window and no narrowing', () => {
    const filters = parseMcpLogFilters(new URLSearchParams('window=last-century'));

    expect(filters.window).toBe('24h');
    expect(hasActiveMcpLogFilters(filters)).toBe(false);
  });
});

describe('buildMcpLogQuery', () => {
  it('composes every set filter into one request, under the API’s own names', () => {
    const filters = parseMcpLogFilters(new URLSearchParams(
      'window=1h&outcome=error&kind=tool&name=propr_list_tasks&repository=integry/propr&client=client-a&user=42'
    ));

    expect(buildMcpLogQuery(filters, { page: 3, limit: 50, now: NOW })).toEqual({
      page: 3,
      limit: 50,
      since: NOW - 60 * 60 * 1000,
      outcome: 'error',
      kind: 'tool',
      name: 'propr_list_tasks',
      repository: 'integry/propr',
      clientId: 'client-a',
      ownerId: '42',
    });
  });

  it('sends only the window when nothing narrows the view', () => {
    const filters = parseMcpLogFilters(new URLSearchParams());

    expect(buildMcpLogQuery(filters, { page: 1, limit: 50, now: NOW })).toEqual({
      page: 1,
      limit: 50,
      since: resolveWindowSince('24h', NOW),
    });
  });
});

describe('value formatting', () => {
  it('renders an absent figure as unavailable rather than zero', () => {
    expect(formatMcpCount(undefined)).toBe(UNAVAILABLE);
    expect(formatMcpCount(0)).toBe('0');
    expect(formatMcpDuration(null)).toBe(UNAVAILABLE);
    expect(formatMcpBytes(undefined)).toBe(UNAVAILABLE);
  });

  it('formats durations and sizes at human scale', () => {
    expect(formatMcpDuration(940)).toBe('940ms');
    expect(formatMcpDuration(2400)).toBe('2.4s');
    expect(formatMcpDuration(95_000)).toBe('1m 35s');
    expect(formatMcpBytes(512)).toBe('512 B');
    expect(formatMcpBytes(2048)).toBe('2.0 KB');
  });

  it('names a connected app, falling back to its client id', () => {
    expect(clientDisplayName({ clientName: 'Claude Desktop', clientId: 'client-a' })).toBe('Claude Desktop');
    expect(clientDisplayName({ clientName: null, clientId: 'client-a' })).toBe('client-a');
    expect(clientDisplayName({ clientName: null, clientId: null })).toBe(UNAVAILABLE);
  });

  it('gives denied and error outcomes their own semantic treatment', () => {
    expect(outcomeTone('success').row).toBe('');
    expect(outcomeTone('denied').row).toContain('amber');
    expect(outcomeTone('error').row).toContain('red');
    expect(outcomeTone('something-new').label).toBe(UNAVAILABLE);
  });
});
