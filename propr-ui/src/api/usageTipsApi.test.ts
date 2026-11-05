import { beforeEach, expect, it, vi } from 'vitest';
import { USAGE_TIPS_CATALOG } from '@propr/shared';
import { getUsageTips, dismissUsageTip } from './usageTipsApi';
import { apiFetch } from './apiClient';
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: vi.fn(), handleApiResponse: vi.fn(async (res: Response) => { if (!res.ok) throw new Error('failed'); }) }));
beforeEach(() => vi.resetAllMocks());
it('GET only reads and drops unknown IDs before the cap', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ enabled: true, tips: [{ id: 'unknown' }, ...USAGE_TIPS_CATALOG.slice(0, 3)] })));
  expect((await getUsageTips()).tips).toHaveLength(3);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(apiFetch).mock.calls[0][1]?.method).toBeUndefined();
});
it('explicit POST preserves the supplied event identifier and enables safe auth replay', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
  const eventId = crypto.randomUUID();
  await dismissUsageTip('pr-review', eventId);
  await dismissUsageTip('pr-review', eventId);
  for (const [, init, options] of vi.mocked(apiFetch).mock.calls) {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ tipId: 'pr-review', eventId });
    expect(options?.replayMutationAfterTokenRefresh).toBe(true);
  }
});

it('preserves personalized advice while retaining catalog titles and documentation links', async () => {
  const tip = USAGE_TIPS_CATALOG[0];
  const body = 'Your instance has recent tasks but few manual reviews. Try /review on a PR to get AI feedback before deciding what needs fixing.';
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ enabled: true, tips: [
    ...[null, '', '   ', 123, 'x'.repeat(241)].map(body => ({ id: tip.id, body })),
    { ...tip, body: ` ${body} `, title: 'Unexpected title', docUrl: 'https://example.com/untrusted' },
  ] })));
  expect((await getUsageTips()).tips).toEqual([{ ...tip, body }]);
});

it('resolves kind from the local catalog instead of trusting API metadata', async () => {
  const corrective = USAGE_TIPS_CATALOG[0];
  const discovery = USAGE_TIPS_CATALOG.find(t => t.kind === 'discovery')!;
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ enabled: true, tips: [
    { ...corrective, kind: 'discovery' }, { ...discovery, kind: 'corrective' },
  ] })));
  expect((await getUsageTips()).tips).toEqual([corrective, discovery]);
});
