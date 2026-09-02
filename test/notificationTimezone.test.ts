import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOTIFICATION_KINDS,
  parseIanaTimezone,
  parseNotificationPreferencesResponse,
  parsePushSubscriptionEndpoint,
} from '@propr/shared';

function preferenceResponse(timezone: string) {
  return {
    preferences: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, {
      inboxEnabled: true,
      pushEnabled: false,
      updatedAt: null,
    }])),
    quietHours: { start: null, end: null, timezone },
  };
}

test('canonicalizes timezone input but keeps trusted response parsing ICU-independent', () => {
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: 'US/Eastern' })
    .resolvedOptions().timeZone;
  assert.equal(parseIanaTimezone('US/Eastern'), canonical);
  assert.throws(() => parseIanaTimezone('Future/Example_City'));
  assert.equal(
    parseNotificationPreferencesResponse(
      preferenceResponse('Future/Example_City'),
    ).quietHours.timezone,
    'Future/Example_City',
  );
});

test('describes the configured loopback exception in endpoint validation errors', () => {
  assert.throws(
    () => parsePushSubscriptionEndpoint('ftp://localhost/push', {
      allowInsecureLocalhost: true,
    }),
    /HTTP\(S\) loopback development URL/,
  );
});
