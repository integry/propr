import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPackagedLayout, parseEventLayout } from '../scripts/packaged-layout.mjs';
import { formatDesktopLogRecord, sanitizeDesktopLogFields } from './logger';

const bounds = (left: number, top: number, width: number, height: number) => ({
  bottom: top + height,
  height,
  left,
  right: left + width,
  top,
  width,
});

const completePackagedLayout = () => ({
  screen: { height: 1080, width: 1920 },
  viewport: { height: 780, width: 1280 },
  entry: bounds(0, 0, 1280, 780),
  card: bounds(350, 40, 580, 640),
  logo: bounds(624, 72, 32, 32),
  heading: bounds(430, 132, 420, 58),
  connectButton: bounds(380, 230, 520, 76),
  connectDescription: bounds(490, 270, 300, 18),
  windowBounds: { x: 0, y: 0, width: 1280, height: 820 },
  contentBounds: { x: 0, y: 0, width: 1280, height: 780 },
  minimumSize: { width: 880, height: 620 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
});

describe('desktop logger field schemas', () => {
  it('logs the complete successful packaged layout for the smoke parser and assertion', () => {
    const inspectedLayout = completePackagedLayout();
    const record = formatDesktopLogRecord(
      'info',
      'desktop.renderer.layout.ready',
      { layout: inspectedLayout },
      '2026-09-02T00:00:00.000Z',
    );
    assert.equal(record, JSON.stringify({
      timestamp: '2026-09-02T00:00:00.000Z',
      level: 'info',
      event: 'desktop.renderer.layout.ready',
      layout: inspectedLayout,
    }));

    const parsedLayout = parseEventLayout(`Chromium prefix\n${record}\n`, 'desktop.renderer.layout.ready');
    assert.deepEqual(parsedLayout, inspectedLayout);
    assert.doesNotThrow(() => assertPackagedLayout(parsedLayout, 'linux'));
    assert.deepEqual(
      sanitizeDesktopLogFields('desktop.renderer.layout.ready', {
        layout: { ...inspectedLayout, missing: [] },
      }),
      { layout: inspectedLayout },
    );
  });

  it('preserves the exact reduced native window geometry schema', () => {
    const layout = {
      displayWorkArea: { x: -1600, y: 0, width: 1600, height: 900 },
      workArea: { x: -1200, y: 170, width: 800, height: 560 },
      windowBounds: { x: -1200, y: 170, width: 800, height: 560, visible: true },
      minimumSize: { width: 800, height: 560 },
    };
    assert.deepEqual(sanitizeDesktopLogFields('desktop.native.reduced_window.ready', { layout }), { layout });
  });

  it('requires own layout and geometry keys despite inherited keys and a shadowed hasOwnProperty', () => {
    const valid = completePackagedLayout();
    const { workArea, ...layoutWithoutOwnWorkArea } = valid;
    const inheritedLayoutKey = Object.assign(Object.create({ workArea }), layoutWithoutOwnWorkArea);
    const inheritedGeometryKey = Object.assign(
      Object.create({ width: valid.windowBounds.width }) as Record<string, unknown>,
      { x: 0, y: 0, height: valid.windowBounds.height, visible: true },
    );
    Object.defineProperty(inheritedGeometryKey, 'hasOwnProperty', {
      value: () => true,
    });

    for (const layout of [
      inheritedLayoutKey,
      { ...valid, windowBounds: inheritedGeometryKey },
    ]) {
      assert.deepEqual(sanitizeDesktopLogFields('desktop.renderer.layout.ready', { layout }), {
        layout: { code: 'DETAIL_REDACTED' },
      });
    }
  });

  it('redacts malformed, secret, path-bearing, array, error, and over-broad layouts', () => {
    const valid = completePackagedLayout();
    const rejectedLayouts: unknown[] = [
      { ...valid, unknown: { width: 1, height: 1 } },
      { ...valid, windowBounds: { ...valid.windowBounds, width: '1280' } },
      { ...valid, windowBounds: [0, 0, 1280, 820] },
      { ...valid, windowBounds: { ...valid.windowBounds, width: Number.POSITIVE_INFINITY } },
      { ...valid, windowBounds: { ...valid.windowBounds, token: 'secret-SENTINEL' } },
      { ...valid, windowBounds: { ...valid.windowBounds, path: '/private/path-SENTINEL' } },
      { ...valid, windowBounds: new Error('/private/path-SENTINEL') },
      { ...valid, windowBounds: { width: 1280, height: 820 } },
      { ...valid, missing: ['connectDescription'] },
      Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
        `geometry${index}`,
        { width: index + 1, height: index + 1 },
      ])),
    ];

    for (const layout of rejectedLayouts) {
      const sanitized = sanitizeDesktopLogFields('desktop.renderer.layout.ready', { layout });
      assert.deepEqual(sanitized, { layout: { code: 'DETAIL_REDACTED' } });
      const serialized = JSON.stringify(sanitized);
      assert.doesNotMatch(serialized, /secret-SENTINEL|private\/path-SENTINEL|connectDescription/u);
    }
  });

  it('redacts a non-empty missing-selector result and leaves layout assertion failed closed', () => {
    const record = formatDesktopLogRecord(
      'info',
      'desktop.renderer.layout.ready',
      { layout: { missing: ['connectButton', 'connectDescription'] } },
      '2026-09-02T00:00:00.000Z',
    );
    assert.doesNotMatch(record, /connectButton|connectDescription/u);
    assert.match(record, /DETAIL_REDACTED/u);

    const parsedLayout = parseEventLayout(record, 'desktop.renderer.layout.ready');
    assert.deepEqual(parsedLayout, { code: 'DETAIL_REDACTED' });
    assert.throws(
      () => assertPackagedLayout(parsedLayout, 'linux'),
      /does not have positive bounds/,
    );
  });

  it('does not weaken general object or error redaction', () => {
    const secret = { token: 'secret-SENTINEL', path: '/private/path-SENTINEL' };
    assert.deepEqual(sanitizeDesktopLogFields('desktop.other', {
      detail: secret,
      error: new Error('/private/path-SENTINEL'),
    }), {
      detail: { code: 'DETAIL_REDACTED' },
      error: { code: 'OPERATION_FAILED' },
    });
  });
});
