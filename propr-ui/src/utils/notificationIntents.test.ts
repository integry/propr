import { describe, expect, test } from 'vitest';
import {
  parsePlanNotificationIntent,
  removeNotificationIntent,
} from './notificationIntents';

describe('plan notification intents', () => {
  test.each([
    ['?intent=refine', 'refine'],
    ['?flow=hosted&intent=approve_execute', 'approve_execute'],
  ])('parses recognized intent from %s', (search, expected) => {
    expect(parsePlanNotificationIntent(search)).toBe(expected);
  });

  test.each([
    '',
    '?intent=execute',
    '?intent=refine&intent=approve_execute',
    '?intent=',
  ])('rejects absent, unknown, or ambiguous intent in %s', search => {
    expect(parsePlanNotificationIntent(search)).toBeNull();
  });

  test('removes only the consumed intent and preserves other routing data', () => {
    expect(removeNotificationIntent('?connect_api_url=flow&intent=approve_execute&tab=plan'))
      .toBe('?connect_api_url=flow&tab=plan');
    expect(removeNotificationIntent('?intent=refine')).toBe('');
  });
});
