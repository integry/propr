import { after, test } from 'node:test';
import assert from 'node:assert';
import {
    BoundedDeliverySet,
    BoundedTokenCache,
    buildConnectUrl,
    closeConnection,
    extractPulledPayload,
    parseTokenExpiry,
    resolveInstallationToken,
    toHttpOrigin,
    validateRoutingUrl,
} from '@propr/core';

// Importing @propr/core eagerly opens the shared DB connection pool; close it so
// the test process can exit cleanly instead of hanging on the open pool.
after(async () => {
    await closeConnection();
});

// These are focused unit tests for the pure protocol helpers that back
// RoutingWebSocketIntakeService. The service-level test exercises them
// indirectly; covering them in isolation makes regressions easier to diagnose.

test('buildConnectUrl maps ws/wss/http/https origins to the ws(s) /v1/connect URL', () => {
    assert.equal(buildConnectUrl('wss://routing.example'), 'wss://routing.example/v1/connect');
    assert.equal(buildConnectUrl('ws://routing.example'), 'ws://routing.example/v1/connect');
    // http(s) origins are upgraded to ws(s) so one PROPR_ROUTING_URL serves both paths.
    assert.equal(buildConnectUrl('https://routing.example'), 'wss://routing.example/v1/connect');
    assert.equal(buildConnectUrl('http://routing.example'), 'ws://routing.example/v1/connect');
    // A trailing slash on the origin must not produce a doubled path segment.
    assert.equal(buildConnectUrl('wss://routing.example/'), 'wss://routing.example/v1/connect');
});

test('toHttpOrigin maps ws(s) to http(s) and trims a trailing slash', () => {
    assert.equal(toHttpOrigin('wss://routing.example'), 'https://routing.example');
    assert.equal(toHttpOrigin('ws://routing.example'), 'http://routing.example');
    assert.equal(toHttpOrigin('https://routing.example/'), 'https://routing.example');
    assert.equal(toHttpOrigin('http://routing.example'), 'http://routing.example');
});

test('validateRoutingUrl accepts bare ws/wss/http/https origins', () => {
    for (const url of [
        'wss://routing.example',
        'ws://routing.example',
        'https://routing.example',
        'http://routing.example',
        'wss://routing.example/', // a lone trailing slash is an empty path
    ]) {
        assert.doesNotThrow(() => validateRoutingUrl(url), `expected ${url} to be valid`);
    }
});

test('validateRoutingUrl rejects unparseable, wrong-scheme, and path-bearing URLs', () => {
    assert.throws(() => validateRoutingUrl('not a url'), /not a valid URL/);
    assert.throws(() => validateRoutingUrl('ftp://routing.example'), /ws:\/\/, wss:\/\/, http:\/\/, or https:\/\//);
    assert.throws(() => validateRoutingUrl('wss://routing.example/v1'), /origin without a path/);
    assert.throws(() => validateRoutingUrl('wss://routing.example/v1/connect'), /origin without a path/);
    assert.throws(() => validateRoutingUrl('wss://routing.example?foo=bar'), /origin without a path/);
    assert.throws(() => validateRoutingUrl('wss://routing.example#frag'), /origin without a path/);
});

test('parseTokenExpiry normalizes numbers and ISO strings, and degrades on garbage', () => {
    assert.equal(parseTokenExpiry(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(parseTokenExpiry('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z'));
    // Unparseable or absent expiry degrades to "non-expiring" (undefined) rather
    // than instantly evicting the token.
    assert.equal(parseTokenExpiry('not a date'), undefined);
    assert.equal(parseTokenExpiry(undefined), undefined);
    assert.equal(parseTokenExpiry(Number.NaN), undefined);
    assert.equal(parseTokenExpiry(Number.POSITIVE_INFINITY), undefined);
});

test('extractPulledPayload unwraps both wrapper shapes and otherwise returns the body', () => {
    assert.deepEqual(extractPulledPayload({ payload: { rawPayload: { a: 1 } } }), { a: 1 });
    assert.deepEqual(extractPulledPayload({ rawPayload: { b: 2 } }), { b: 2 });
    // No recognized wrapper: the body itself is the GitHub payload.
    assert.deepEqual(extractPulledPayload({ action: 'opened' }), { action: 'opened' });
    // A null/undefined rawPayload is not treated as a payload.
    assert.deepEqual(extractPulledPayload({ payload: { rawPayload: null }, fallback: true }), {
        payload: { rawPayload: null },
        fallback: true,
    });
    assert.equal(extractPulledPayload('raw string'), 'raw string');
});

test('BoundedDeliverySet evicts the oldest entries once the cap is reached', () => {
    const set = new BoundedDeliverySet(2);
    set.add('a');
    set.add('b');
    set.add('c'); // 'a' is the oldest and is evicted
    assert.equal(set.has('a'), false);
    assert.equal(set.has('b'), true);
    assert.equal(set.has('c'), true);
    assert.equal(set.size, 2);
});

test('BoundedDeliverySet refreshes recency so a re-added id is evicted last', () => {
    const set = new BoundedDeliverySet(2);
    set.add('a');
    set.add('b');
    set.add('a'); // touching 'a' moves it to most-recent; 'b' is now oldest
    set.add('c'); // evicts 'b', not the refreshed 'a'
    assert.equal(set.has('a'), true);
    assert.equal(set.has('b'), false);
    assert.equal(set.has('c'), true);
});

test('BoundedDeliverySet clamps a non-positive cap to 1 so dedupe is never disabled', () => {
    const set = new BoundedDeliverySet(0);
    set.add('a');
    assert.equal(set.has('a'), true);
    set.add('b');
    assert.equal(set.size, 1);
    assert.equal(set.has('a'), false);
});

test('BoundedTokenCache evicts the oldest token once the cap is reached', () => {
    const cache = new BoundedTokenCache(2, () => 1_000);
    cache.set('a', 't-a');
    cache.set('b', 't-b');
    cache.set('c', 't-c'); // evicts 'a'
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 't-b');
    assert.equal(cache.get('c'), 't-c');
});

test('BoundedTokenCache refreshes recency on re-set so the touched key survives eviction', () => {
    const cache = new BoundedTokenCache(2, () => 1_000);
    cache.set('a', 't-a');
    cache.set('b', 't-b');
    cache.set('a', 't-a2'); // re-set 'a': newest value and most-recent position
    cache.set('c', 't-c'); // evicts 'b', keeps refreshed 'a'
    assert.equal(cache.get('a'), 't-a2');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 't-c');
});

test('BoundedTokenCache treats an expired token as a miss and drops it', () => {
    let now = 1_000;
    const cache = new BoundedTokenCache(5, () => now);
    cache.set('a', 't-a', 2_000); // expires at 2000
    assert.equal(cache.get('a'), 't-a'); // still valid at now=1000
    now = 2_000; // at-or-past expiry counts as expired
    assert.equal(cache.get('a'), undefined);
    now = 1_000; // and it was dropped, so it stays a miss even if the clock rewinds
    assert.equal(cache.get('a'), undefined);
});

test('BoundedTokenCache treats a token with no expiry as non-expiring', () => {
    let now = 1_000;
    const cache = new BoundedTokenCache(5, () => now);
    cache.set('a', 't-a');
    now = Number.MAX_SAFE_INTEGER;
    assert.equal(cache.get('a'), 't-a');
});

test('resolveInstallationToken prefers the frame token, then the cache, else undefined', () => {
    const cache = new BoundedTokenCache(5, () => 1_000);
    cache.set('42', 'cached');

    // Frame-supplied token wins outright.
    assert.equal(resolveInstallationToken({ installationToken: 'inline', installationId: 42 }, cache), 'inline');
    // No frame token: fall back to the cache keyed by installation id.
    assert.equal(resolveInstallationToken({ installationId: 42 }, cache), 'cached');
    // Cache miss / no installation id: undefined.
    assert.equal(resolveInstallationToken({ installationId: 99 }, cache), undefined);
    assert.equal(resolveInstallationToken({}, cache), undefined);
});
