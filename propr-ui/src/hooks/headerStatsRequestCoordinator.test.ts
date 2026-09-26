import { describe, expect, it, vi } from 'vitest';
import { coalesceHeaderStatsRead } from './headerStatsRequestCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('header stats request coordinator', () => {
  it('shares concurrent reads only for the same identity and resource', async () => {
    const pending = deferred<number>();
    const read = vi.fn(() => pending.promise);
    const first = coalesceHeaderStatsRead('instance-a\0user-a', 'tasks', read);
    const second = coalesceHeaderStatsRead('instance-a\0user-a', 'tasks', read);
    const otherResource = coalesceHeaderStatsRead('instance-a\0user-a', 'status', read);
    const otherIdentity = coalesceHeaderStatsRead('instance-a\0user-b', 'tasks', read);

    expect(read).toHaveBeenCalledTimes(3);
    pending.resolve(7);
    await expect(Promise.all([first, second, otherResource, otherIdentity])).resolves.toEqual([7, 7, 7, 7]);
  });

  it('does not retain a settled response as a stale cache', async () => {
    const read = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(coalesceHeaderStatsRead('scope', 'drafts', read)).resolves.toBe(1);
    await expect(coalesceHeaderStatsRead('scope', 'drafts', read)).resolves.toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
