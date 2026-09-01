import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeDesktopLogFields } from './logger';

describe('desktop logger field schemas', () => {
  it('preserves only bounded numeric and boolean packaged layout measurements', () => {
    assert.deepEqual(sanitizeDesktopLogFields('desktop.renderer.layout.ready', {
      layout: {
        windowBounds: { x: 12, y: 24, width: 1280, height: 820, visible: true },
        viewport: { width: 1240, height: 760 },
        card: { top: 10.5, right: 900, bottom: 700, left: 100, width: 800, height: 690 },
      },
    }), {
      layout: {
        windowBounds: { x: 12, y: 24, width: 1280, height: 820, visible: true },
        viewport: { width: 1240, height: 760 },
        card: { top: 10.5, right: 900, bottom: 700, left: 100, width: 800, height: 690 },
      },
    });
  });

  it('does not weaken object, secret, path, error, or malformed-layout redaction', () => {
    const secret = { token: 'secret-SENTINEL', path: '/private/path-SENTINEL' };
    assert.deepEqual(sanitizeDesktopLogFields('desktop.other', { detail: secret }), {
      detail: { code: 'DETAIL_REDACTED' },
    });
    assert.deepEqual(sanitizeDesktopLogFields('desktop.renderer.layout.ready', {
      layout: { windowBounds: { width: 1280, token: 'secret-SENTINEL' } },
      error: new Error('/private/path-SENTINEL'),
      evidence: secret,
    }), {
      layout: { code: 'DETAIL_REDACTED' },
      error: { code: 'OPERATION_FAILED' },
      evidence: { code: 'DETAIL_REDACTED' },
    });
  });
});
