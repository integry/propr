import { describe, expect, it } from 'vitest';
import { DESKTOP_TRANSPORT_SCOPE_QUERY } from '@propr/shared';
import { staleReconnectQuery } from './packagedTransportSmoke';

describe('packaged transport smoke scope query', () => {
  it('preserves the recorded stale scope instead of substituting the current scope', () => {
    const recordedStaleScope = 'AAAAAAAAAAAAAAAAAAAAAA';
    const freshCurrentScope = 'BBBBBBBBBBBBBBBBBBBBBB';

    const query = staleReconnectQuery(recordedStaleScope, freshCurrentScope);

    expect(Object.keys(query)).toEqual([DESKTOP_TRANSPORT_SCOPE_QUERY]);
    expect(query[DESKTOP_TRANSPORT_SCOPE_QUERY]).toBe(recordedStaleScope);
    expect(query[DESKTOP_TRANSPORT_SCOPE_QUERY]).not.toBe(freshCurrentScope);
  });

  it('rejects a stale-boundary check without an actual scope rotation', () => {
    expect(() => staleReconnectQuery(
      'AAAAAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAA',
    )).toThrow('Packaged stale Socket.IO activation was not rotated');
  });
});
