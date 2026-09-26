import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPackagedLayout, parseEventRecord } from './packaged-layout.mjs';

const bounds = (left, top, width, height) => ({
  bottom: top + height,
  height,
  left,
  right: left + width,
  top,
  width,
});

const layout = ({
  windowWidth = 1280,
  windowHeight = 820,
  viewportWidth = 1280,
  viewportHeight = 820,
  workAreaWidth = 1280,
  workAreaHeight = 900,
  inset = { left: 3, top: 0, right: 0, bottom: 3 },
} = {}) => ({
  windowBounds: { x: 0, y: 0, width: windowWidth, height: windowHeight },
  contentBounds: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
  workArea: { x: 0, y: 0, width: workAreaWidth, height: workAreaHeight },
  viewport: { width: viewportWidth, height: viewportHeight },
  chrome: {
    dragRegion: bounds(inset.left, inset.top, viewportWidth - inset.left - inset.right - 138, 44),
    dragRegionStyle: 'drag',
    legacyTitleRowCount: 0,
    nativeControlLabels: ['Minimize window', 'Maximize or restore window', 'Close window'],
    nativeControlRegion: bounds(viewportWidth - inset.right - 138, inset.top, 138, 44),
    nativeControlRegionStyle: 'no-drag',
    overlayRect: bounds(0, 0, 0, 0),
    overlayVisible: false,
  },
  nativeChrome: {
    closable: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
  },
  entry: bounds(inset.left, inset.top, viewportWidth - inset.left - inset.right, viewportHeight - inset.top - inset.bottom),
  card: bounds((viewportWidth - 580) / 2, 40, 580, 640),
  logo: bounds((viewportWidth - 32) / 2, 72, 32, 32),
  heading: bounds((viewportWidth - 420) / 2, 132, 420, 58),
  connectButton: bounds((viewportWidth - 520) / 2, 230, 520, 76),
  connectDescription: bounds((viewportWidth - 300) / 2, 270, 300, 18),
});

describe('packaged desktop event parsing', () => {
  it('returns the first full record for the exact matching event', () => {
    const firstProof = {
      event: 'desktop.renderer.mvp_flows.ready',
      localProfile: true,
      remoteActiveProfile: true,
      lifecycleBoundary: true,
      connectUiPopulated: true,
    };
    const output = [
      'not JSON: desktop.renderer.mvp_flows.ready',
      JSON.stringify({ event: 'desktop.renderer.mvp_flows.ready.extra', localProfile: false }),
      JSON.stringify({ event: 'desktop.renderer.other', note: 'desktop.renderer.mvp_flows.ready' }),
      JSON.stringify(firstProof),
      JSON.stringify({ event: 'desktop.renderer.mvp_flows.ready', localProfile: false }),
    ].join('\n');

    assert.deepEqual(parseEventRecord(output, firstProof.event), firstProof);
  });

  it('returns undefined when the event is absent', () => {
    const output = [
      '{malformed',
      JSON.stringify({ event: 'desktop.renderer.other' }),
    ].join('\n');

    assert.equal(parseEventRecord(output, 'desktop.renderer.mvp_flows.ready'), undefined);
  });
});

describe('packaged desktop layout assertions', () => {
  it('retains the exact 1280x820 Linux Xvfb proof', () => {
    // Regression evidence from #2276: approved 44px chrome, left/bottom inset,
    // and controls flush with the right viewport edge.
    assert.deepEqual(layout().chrome.dragRegion, bounds(3, 0, 1139, 44));
    assert.deepEqual(layout().chrome.nativeControlRegion, bounds(1142, 0, 138, 44));
    assert.doesNotThrow(() => assertPackagedLayout(layout(), 'linux'));
    assert.throws(
      () => assertPackagedLayout(layout({ windowWidth: 1279 }), 'linux'),
      /Linux window was not 1280x820/,
    );
  });

  for (const [name, inset] of [
    ['expanded edge-flush frame', { left: 0, top: 0, right: 0, bottom: 0 }],
    ['symmetrically inset frame', { left: 3, top: 3, right: 3, bottom: 3 }],
    ['asymmetrically inset frame', { left: 3, top: 2, right: 5, bottom: 4 }],
  ]) {
    it(`accepts a contained Linux ${name}`, () => {
      assert.doesNotThrow(() => assertPackagedLayout(layout({ inset }), 'linux'));
    });
  }

  it('rejects Linux client decoration and reduced native capabilities', () => {
    assert.throws(
      () => assertPackagedLayout(layout({ viewportWidth: 1272, viewportHeight: 816 }), 'linux'),
      /client decoration changed the requested window boundary/,
    );
    const unresizable = layout();
    unresizable.nativeChrome.resizable = false;
    assert.throws(
      () => assertPackagedLayout(unresizable, 'linux'),
      /native window capabilities were reduced/,
    );
  });

  for (const [name, change] of [
    ['legacy title row', chrome => { chrome.legacyTitleRowCount = 1; }],
    ['native overlay alongside custom controls', chrome => { chrome.overlayVisible = true; }],
    ['duplicate controls', chrome => { chrome.nativeControlLabels.push(...chrome.nativeControlLabels); }],
    ['missing control', chrome => { chrome.nativeControlLabels.pop(); }],
    ['incorrect control label', chrome => { chrome.nativeControlLabels[0] = 'Close window'; }],
    ['non-draggable title band', chrome => { chrome.dragRegionStyle = 'no-drag'; }],
    ['draggable controls', chrome => { chrome.nativeControlRegionStyle = 'drag'; }],
    ['overlapping drag and controls', chrome => { chrome.dragRegion = bounds(3, 0, 1140, 44); }],
    ['gap between drag and controls', chrome => { chrome.dragRegion = bounds(3, 0, 1138, 44); }],
    ['drag clipped by viewport', chrome => { chrome.dragRegion = bounds(-1, 0, 1143, 44); }],
    ['drag outside inset entry', chrome => { chrome.dragRegion = bounds(0, 0, 1142, 44); }],
    ['gap at entry left edge', chrome => { chrome.dragRegion = bounds(4, 0, 1138, 44); }],
    ['controls clipped by viewport', chrome => {
      chrome.dragRegion = bounds(3, 0, 1140, 44);
      chrome.nativeControlRegion = bounds(1143, 0, 138, 44);
    }],
    ['gap at entry right edge', chrome => {
      chrome.dragRegion = bounds(3, 0, 1138, 44);
      chrome.nativeControlRegion = bounds(1141, 0, 138, 44);
    }],
    ['controls above viewport', chrome => { chrome.nativeControlRegion = bounds(1142, -1, 138, 44); }],
    ['vertically misaligned controls', chrome => { chrome.nativeControlRegion = bounds(1142, 1, 138, 44); }],
    ['title band below entry top', chrome => {
      chrome.dragRegion = bounds(3, 1, 1139, 44);
      chrome.nativeControlRegion = bounds(1142, 1, 138, 44);
    }],
    ['old 56px title band', chrome => {
      chrome.dragRegion = bounds(3, 0, 1139, 56);
      chrome.nativeControlRegion = bounds(1142, 0, 138, 56);
    }],
    ['undersized drag band', chrome => { chrome.dragRegion = bounds(3, 0, 1139, 43); }],
    ['oversized controls', chrome => { chrome.nativeControlRegion = bounds(1142, 0, 138, 45); }],
    ['undersized controls', chrome => { chrome.nativeControlRegion = bounds(1142, 0, 138, 43); }],
    ['narrow controls', chrome => {
      chrome.dragRegion = bounds(3, 0, 1140, 44);
      chrome.nativeControlRegion = bounds(1143, 0, 137, 44);
    }],
    ['wide controls', chrome => {
      chrome.dragRegion = bounds(3, 0, 1138, 44);
      chrome.nativeControlRegion = bounds(1141, 0, 139, 44);
    }],
  ]) {
    it(`rejects Linux chrome with ${name}`, () => {
      const invalid = layout();
      change(invalid.chrome);
      assert.throws(() => assertPackagedLayout(invalid, 'linux'), /not one safe native-control band/);
    });
  }

  it('rejects controls inside the viewport but clipped by an inset entry', () => {
    const invalid = layout({ inset: { left: 3, top: 3, right: 3, bottom: 3 } });
    invalid.chrome.dragRegion = bounds(3, 3, 1139, 44);
    invalid.chrome.nativeControlRegion = bounds(1142, 3, 138, 44);
    assert.throws(() => assertPackagedLayout(invalid, 'linux'), /not one safe native-control band/);
  });

  it('rejects malformed chrome rectangles', () => {
    for (const region of ['dragRegion', 'nativeControlRegion']) {
      const inconsistent = layout();
      inconsistent.chrome[region].right += 1;
      assert.throws(() => assertPackagedLayout(inconsistent, 'linux'), /inconsistent bounds/);
      const empty = layout();
      empty.chrome[region] = bounds(3, 0, 0, 44);
      assert.throws(() => assertPackagedLayout(empty, 'linux'), /does not have positive bounds/);
    }
  });

  it('retains welcome-content clipping, overlap, and sizing checks with the inset frame', () => {
    const clipped = layout();
    clipped.entry = bounds(3, 0, 1278, 817);
    assert.throws(() => assertPackagedLayout(clipped, 'linux'), /outside the renderer viewport/);
    const outsideCard = layout();
    outsideCard.logo = bounds(0, 72, 32, 32);
    assert.throws(() => assertPackagedLayout(outsideCard, 'linux'), /outside its layout container/);
    const overlapping = layout();
    overlapping.heading = bounds(430, 100, 420, 58);
    assert.throws(() => assertPackagedLayout(overlapping, 'linux'), /overlapping or out of order/);
    const oversized = layout();
    oversized.logo = bounds(624, 72, 35, 35);
    assert.throws(() => assertPackagedLayout(oversized, 'linux'), /logo has unreasonable bounds/);
  });

  it('accepts a safe 1024x720 Windows display clamp with intact contained content', () => {
    assert.doesNotThrow(() => assertPackagedLayout(layout({
      windowWidth: 1024,
      windowHeight: 720,
      viewportWidth: 1024,
      viewportHeight: 681,
      workAreaWidth: 1024,
      workAreaHeight: 720,
      inset: { left: 0, top: 0, right: 0, bottom: 0 },
    }), 'win32'));
  });

  it('rejects unsafe Windows clamps and content outside the visible work area', () => {
    assert.throws(
      () => assertPackagedLayout(layout({ windowWidth: 879 }), 'win32'),
      /outside the safe clamped range/,
    );
    assert.throws(
      () => assertPackagedLayout(layout({ workAreaWidth: 1024 }), 'win32'),
      /outside the visible work area/,
    );
  });
});
