import { after, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '@propr/core';
// These are internal wire-protocol primitives, deliberately not exported from the
// package root, so the test imports them directly from the source module.
import {
    ACCEPTED_DISPOSITION,
    BoundedDeliveryMap,
    BoundedDeliverySet,
    BoundedTokenCache,
    DeliveryTracker,
    IGNORED_UNSUPPORTED_DISPOSITION,
    buildAckFrame,
    buildConnectUrl,
    extractPulledPayload,
    normalizeDisposition,
    parseTokenExpiry,
    resolveInstallationToken,
    toHttpOrigin,
    validateRoutingUrl,
} from '../packages/core/src/intake/routingWebSocketProtocol.js';

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

test('validateRoutingUrl accepts secure origins and insecure localhost origins', () => {
    for (const url of [
        'wss://routing.example',
        'https://routing.example',
        'wss://routing.example/', // a lone trailing slash is an empty path
        'ws://localhost:8080', // insecure allowed only for localhost
        'http://127.0.0.1:8080',
        'http://[::1]:8080',
    ]) {
        assert.doesNotThrow(() => validateRoutingUrl(url), `expected ${url} to be valid`);
    }
});

test('validateRoutingUrl rejects insecure non-localhost origins', () => {
    // The hardened policy refuses unencrypted ws://, http:// to anything but
    // localhost, so a directly-constructed service cannot dial an insecure
    // remote origin even though the boot/CLI check would have caught it too.
    assert.throws(() => validateRoutingUrl('ws://routing.example'), /wss:\/\/ or https:\/\//);
    assert.throws(() => validateRoutingUrl('http://routing.example'), /wss:\/\/ or https:\/\//);
});

test('validateRoutingUrl rejects unparseable, wrong-scheme, and path-bearing URLs', () => {
    assert.throws(() => validateRoutingUrl('not a url'), /not a valid URL/);
    assert.throws(() => validateRoutingUrl('ftp://routing.example'), /wss:\/\/ or https:\/\//);
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

test('buildAckFrame always carries a status and includes reason/billing only when present', () => {
    // Bare accepted: status only, no reason/billing keys on the wire.
    assert.deepEqual(buildAckFrame(5, 'd1', ACCEPTED_DISPOSITION), {
        type: 'ack',
        sequence: 5,
        deliveryId: 'd1',
        status: 'accepted',
    });
    // Ignored carries a reason but no billing.
    assert.deepEqual(buildAckFrame(6, 'd2', IGNORED_UNSUPPORTED_DISPOSITION), {
        type: 'ack',
        sequence: 6,
        deliveryId: 'd2',
        status: 'ignored',
        reason: 'unsupported_event',
    });
    // Full disposition: reason and billing both included.
    assert.deepEqual(
        buildAckFrame(7, 'd3', { status: 'blocked', reason: 'limit_reached', billing: { seatConsumed: false } }),
        { type: 'ack', sequence: 7, deliveryId: 'd3', status: 'blocked', reason: 'limit_reached', billing: { seatConsumed: false } },
    );
    // Non-accepted dispositions are terminal non-processing outcomes; even if a
    // buggy dispatcher claims a consumed seat, the wire frame must not.
    assert.deepEqual(
        buildAckFrame(8, 'd4', { status: 'ignored', reason: 'user_not_allowed', billing: { seatConsumed: true } }),
        { type: 'ack', sequence: 8, deliveryId: 'd4', status: 'ignored', reason: 'user_not_allowed', billing: { seatConsumed: false } },
    );
    // Exact trigger evidence is accepted-only, deduplicated, and bounded to
    // valid GitHub comment IDs before crossing the routing trust boundary.
    assert.deepEqual(
        buildAckFrame(9, 'd5', {
            status: 'accepted',
            billing: { seatConsumed: true },
            evidence: { triggerCommentIds: [4992520130, 4992520130, -1] },
        }),
        {
            type: 'ack',
            sequence: 9,
            deliveryId: 'd5',
            status: 'accepted',
            billing: { seatConsumed: true },
            evidence: { triggerCommentIds: [4992520130] },
        },
    );
});

test('normalizeDisposition maps void/garbage to accepted and honors a valid disposition', () => {
    // A dispatcher that returns nothing is a plain accept.
    assert.equal(normalizeDisposition(undefined), ACCEPTED_DISPOSITION);
    // Unknown/missing status degrades to accepted rather than suppressing the ACK.
    assert.equal(normalizeDisposition({} as never), ACCEPTED_DISPOSITION);
    assert.equal(normalizeDisposition({ status: 'maybe' } as never), ACCEPTED_DISPOSITION);
    // A recognized status is honored verbatim (same object reference returned).
    const blocked = { status: 'blocked' as const, reason: 'limit_reached' };
    assert.equal(normalizeDisposition(blocked), blocked);
});

test('BoundedDeliveryMap stores values, refreshes recency on set, and evicts the oldest', () => {
    const map = new BoundedDeliveryMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 3); // re-set 'a': newest value and most-recent position
    map.set('c', 4); // evicts 'b' (least-recently-seen), keeps refreshed 'a'
    assert.equal(map.get('a'), 3);
    assert.equal(map.get('b'), undefined);
    assert.equal(map.get('c'), 4);
    assert.equal(map.size, 2);
    // touch refreshes recency without changing the value; a no-op for unknown ids.
    map.touch('a');
    map.touch('missing');
    map.set('d', 5); // evicts 'c', keeps touched 'a'
    assert.equal(map.get('a'), 3);
    assert.equal(map.get('c'), undefined);
});

test('DeliveryTracker remembers the disposition an accepted delivery was ACKed with', () => {
    const tracker = new DeliveryTracker(10);
    tracker.begin('d1');
    assert.equal(tracker.isInFlight('d1'), true);
    const disposition = { status: 'ignored' as const, reason: 'user_not_allowed' };
    tracker.accept('d1', disposition);
    assert.equal(tracker.isInFlight('d1'), false);
    assert.equal(tracker.isAccepted('d1'), true);
    assert.equal(tracker.getDisposition('d1'), disposition);
    // An unknown delivery has no stored disposition.
    assert.equal(tracker.getDisposition('nope'), undefined);
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
