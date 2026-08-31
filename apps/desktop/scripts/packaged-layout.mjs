const EXPECTED_WINDOW_SIZE = { width: 1280, height: 820 };
const MINIMUM_WINDOW_SIZE = { width: 880, height: 620 };

const fail = message => {
  throw new Error(message);
};

const assertPositiveDimensions = (name, bounds) => {
  if (!bounds
    || !Number.isFinite(bounds.width) || bounds.width <= 0
    || !Number.isFinite(bounds.height) || bounds.height <= 0) {
    fail(`Packaged ${name} does not have positive bounds: ${JSON.stringify(bounds)}`);
  }
};

const assertElementBounds = (name, bounds) => {
  assertPositiveDimensions(name, bounds);
  if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
    || bounds.right - bounds.left !== bounds.width
    || bounds.bottom - bounds.top !== bounds.height) {
    fail(`Packaged ${name} has inconsistent bounds: ${JSON.stringify(bounds)}`);
  }
};

const contains = (outer, inner) => inner.left >= outer.left
  && inner.top >= outer.top
  && inner.right <= outer.right
  && inner.bottom <= outer.bottom;

export const assertPackagedLayout = (layout, platform = process.platform) => {
  if (!layout) fail('Packaged desktop did not report renderer layout bounds');
  if (layout.missing?.length) {
    fail(`Packaged renderer layout was missing: ${layout.missing.join(', ')}`);
  }

  assertPositiveDimensions('window', layout.windowBounds);
  assertPositiveDimensions('visible work area', layout.workArea);
  if (![layout.windowBounds.x, layout.windowBounds.y, layout.workArea.x, layout.workArea.y].every(Number.isFinite)) {
    fail(`Packaged window or visible work area has invalid coordinates: ${JSON.stringify({
      windowBounds: layout.windowBounds,
      workArea: layout.workArea,
    })}`);
  }

  if (platform === 'linux') {
    if (layout.windowBounds.width !== EXPECTED_WINDOW_SIZE.width
      || layout.windowBounds.height !== EXPECTED_WINDOW_SIZE.height) {
      fail(`Packaged Linux window was not 1280x820: ${JSON.stringify(layout.windowBounds)}`);
    }
  } else if (platform === 'win32') {
    if (layout.windowBounds.width < MINIMUM_WINDOW_SIZE.width
      || layout.windowBounds.height < MINIMUM_WINDOW_SIZE.height
      || layout.windowBounds.width > EXPECTED_WINDOW_SIZE.width
      || layout.windowBounds.height > EXPECTED_WINDOW_SIZE.height) {
      fail(`Packaged Windows window was outside the safe clamped range: ${JSON.stringify(layout.windowBounds)}`);
    }
  } else {
    fail(`Packaged layout assertion does not support ${platform}`);
  }

  const windowRight = layout.windowBounds.x + layout.windowBounds.width;
  const windowBottom = layout.windowBounds.y + layout.windowBounds.height;
  const workAreaRight = layout.workArea.x + layout.workArea.width;
  const workAreaBottom = layout.workArea.y + layout.workArea.height;
  if (layout.windowBounds.x < layout.workArea.x
    || layout.windowBounds.y < layout.workArea.y
    || windowRight > workAreaRight
    || windowBottom > workAreaBottom) {
    fail(`Packaged window extends outside the visible work area: ${JSON.stringify({
      windowBounds: layout.windowBounds,
      workArea: layout.workArea,
    })}`);
  }

  assertPositiveDimensions('renderer viewport', layout.viewport);
  if (layout.viewport.width > layout.windowBounds.width || layout.viewport.height > layout.windowBounds.height) {
    fail(`Packaged renderer viewport extends outside the window: ${JSON.stringify(layout.viewport)}`);
  }
  if (platform === 'linux' && (layout.viewport.width < 1200 || layout.viewport.height < 740)) {
    fail(`Packaged Linux renderer viewport is unexpectedly small: ${JSON.stringify(layout.viewport)}`);
  }

  const elementNames = ['entry', 'card', 'logo', 'heading', 'connectButton', 'connectDescription'];
  for (const name of elementNames) assertElementBounds(name, layout[name]);
  const viewportBounds = {
    top: 0,
    left: 0,
    right: layout.viewport.width,
    bottom: layout.viewport.height,
  };
  if (elementNames.some(name => !contains(viewportBounds, layout[name]))) {
    fail('Packaged welcome-card content extends outside the renderer viewport');
  }
  if (!contains(layout.entry, layout.card)
    || !contains(layout.card, layout.logo)
    || !contains(layout.card, layout.heading)
    || !contains(layout.card, layout.connectButton)
    || !contains(layout.connectButton, layout.connectDescription)) {
    fail('Packaged welcome-card content extends outside its layout container');
  }

  if (layout.logo.height < 30 || layout.logo.height > 34 || layout.logo.width < 30 || layout.logo.width > 34) {
    fail(`Packaged welcome-card logo has unreasonable bounds: ${JSON.stringify(layout.logo)}`);
  }
  if (layout.card.width < 540 || layout.card.width > 620 || layout.connectButton.height < 60) {
    fail(`Packaged welcome card or connection control has unreasonable bounds: ${JSON.stringify(layout)}`);
  }
  if (layout.heading.top <= layout.logo.bottom || layout.connectButton.top <= layout.heading.bottom) {
    fail('Packaged welcome-card content is overlapping or out of order');
  }
};
