import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftListItem } from '../api/plannerTypes';
import { PlansList } from './PlansPageComponents';
import { formatRelativeTime, parseApiTimestamp } from './PlansPageUtils';

// Observed in issue #3272: screenshot at 21:44:43Z, drafts written by SQLite at 21:35:43 and 21:40:37 UTC.
const NOW = Date.parse('2026-10-19T21:44:43.516Z');
const ZONES = [
  { zone: 'Europe/London', offsetMinutes: -60 }, // BST, UTC+1
  { zone: 'America/New_York', offsetMinutes: 240 }, // EDT, UTC-4
  { zone: 'UTC', offsetMinutes: 0 },
];

const originalTz = process.env.TZ;
const useZone = (zone: string, offsetMinutes: number) => {
  process.env.TZ = zone;
  // Guard against a runtime that ignores TZ changes, which would make these tests pass vacuously.
  expect(new Date(NOW).getTimezoneOffset()).toBe(offsetMinutes);
};

afterEach(() => {
  process.env.TZ = originalTz;
  vi.useRealTimers();
});

describe.each(ZONES)('Plans timestamps in $zone', ({ zone, offsetMinutes }) => {
  beforeEach(() => useZone(zone, offsetMinutes));

  it('reads zone-less SQLite timestamps as UTC', () => {
    expect(parseApiTimestamp('2026-10-19 21:35:43')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(parseApiTimestamp('2026-10-19T21:35:43')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(parseApiTimestamp('2026-10-19 21:35:43.250')?.toISOString()).toBe('2026-10-19T21:35:43.250Z');
    expect(formatRelativeTime('2026-10-19 21:35:43', NOW)).toBe('9 minutes ago');
    expect(formatRelativeTime('2026-10-19 21:40:37', NOW)).toBe('4 minutes ago');
  });

  it('keeps explicit UTC and numeric offsets', () => {
    expect(parseApiTimestamp('2026-10-19T21:35:43Z')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(parseApiTimestamp('2026-10-19T21:35:43.000Z')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(parseApiTimestamp('2026-10-19T22:35:43+01:00')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(parseApiTimestamp('2026-10-19T17:35:43-04:00')?.toISOString()).toBe('2026-10-19T21:35:43.000Z');
    expect(formatRelativeTime('2026-10-19T22:40:37+01:00', NOW)).toBe('4 minutes ago');
    expect(formatRelativeTime('2026-10-19T19:44:43.516Z', NOW)).toBe('2 hours ago');
  });

  it('preserves the minute, hour and day boundaries and plurals', () => {
    const ago = (ms: number) => new Date(NOW - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const at = (ms: number) => formatRelativeTime(ago(ms), Math.floor(NOW / 1000) * 1000);
    const second = 1000;
    const minute = 60 * second;
    const hour = 60 * minute;
    const day = 24 * hour;

    expect(at(0)).toBe('just now');
    expect(at(59 * second)).toBe('just now');
    expect(at(minute)).toBe('1 minute ago');
    expect(at(2 * minute)).toBe('2 minutes ago');
    expect(at(hour - second)).toBe('59 minutes ago');
    expect(at(hour)).toBe('1 hour ago');
    expect(at(2 * hour)).toBe('2 hours ago');
    expect(at(day - second)).toBe('23 hours ago');
    expect(at(day)).toBe('1 day ago');
    expect(at(2 * day)).toBe('2 days ago');
    expect(at(30 * day - second)).toBe('29 days ago');
  });

  it('falls back to a locale date for the UTC instant after 30 days', () => {
    // 23:30 UTC is already the next calendar day in London but not in New York.
    const expected = new Date('2026-08-01T23:30:00Z').toLocaleDateString();
    expect(formatRelativeTime('2026-08-01 23:30:00', NOW)).toBe(expected);
  });

  it('treats a server clock slightly ahead as just now', () => {
    expect(formatRelativeTime('2026-10-19 21:45:10', NOW)).toBe('just now');
  });

  it('renders the corrected age in the Plans list', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const draft: DraftListItem = {
      draft_id: 'd1', repository: 'integry/propr', name: 'Plan', initial_prompt: 'Plan',
      status: 'executed', created_at: '2026-10-19 21:35:43', updated_at: '2026-10-19 21:40:37',
    };
    render(
      <MemoryRouter>
        <PlansList drafts={[draft]} abortingId={null} onDelete={vi.fn()} onAbort={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('4 minutes ago')).toBeInTheDocument();
    expect(screen.queryByText(/hour/)).not.toBeInTheDocument();
  });
});

describe('Plans timestamps that cannot be read', () => {
  it.each([undefined, null, '', '   ', 'not a date', '2026-13-45 99:99:99'])('renders %j as an empty label', value => {
    expect(parseApiTimestamp(value)).toBeNull();
    expect(formatRelativeTime(value, NOW)).toBe('');
  });
});
