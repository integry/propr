import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

export const PREFERRED_WINDOW_SIZE = Object.freeze({ width: 1280, height: 820 });
export const MINIMUM_WINDOW_SIZE = Object.freeze({ width: 880, height: 620 });

const MAX_DISPLAY_DIMENSION = 32_768;
const MAX_XAUTHORITY_BYTES = 64 * 1024;
const PRIVATE_SMOKE_PREFIX = 'propr-desktop-smoke-';
const createdProfiles = new WeakSet();

const assertDimension = (value, description) => {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DISPLAY_DIMENSION) {
    throw new Error(`Packaged layout reported invalid ${description}`);
  }
};

const assertDimensions = (value, description) => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Packaged layout did not report ${description}`);
  }
  assertDimension(value.width, `${description} width`);
  assertDimension(value.height, `${description} height`);
};

const assertGap = (before, after, minimum, description) => {
  const gap = after.top - before.bottom;
  if (gap < minimum) {
    throw new Error(`Packaged layout ${description} gap was ${gap}px; expected at least ${minimum}px`);
  }
};

export const assertPackagedLayout = layout => {
  if (!layout) throw new Error('Packaged desktop did not report renderer layout bounds');
  if (layout.missing?.length) {
    throw new Error(`Packaged renderer layout was missing: ${layout.missing.join(', ')}`);
  }

  assertDimensions(layout.windowBounds, 'native window bounds');
  assertDimensions(layout.contentBounds, 'native content bounds');
  assertDimensions(layout.viewport, 'renderer viewport');
  assertDimensions(layout.screen, 'renderer screen dimensions');
  assertDimensions(layout.workArea, 'renderer available work area');

  if (layout.workArea.width > layout.screen.width || layout.workArea.height > layout.screen.height) {
    throw new Error('Packaged renderer available work area exceeds its screen dimensions');
  }

  const expectedWindow = {
    width: Math.min(PREFERRED_WINDOW_SIZE.width, layout.workArea.width),
    height: Math.min(PREFERRED_WINDOW_SIZE.height, layout.workArea.height),
  };
  if (layout.windowBounds.width !== expectedWindow.width || layout.windowBounds.height !== expectedWindow.height) {
    throw new Error('Packaged window does not equal its preferred size clamped to the available work area');
  }
  if (layout.windowBounds.width > layout.workArea.width || layout.windowBounds.height > layout.workArea.height) {
    throw new Error('Packaged window extends beyond the available work area');
  }
  for (const dimension of ['width', 'height']) {
    if (
      layout.workArea[dimension] >= MINIMUM_WINDOW_SIZE[dimension]
      && layout.windowBounds[dimension] < MINIMUM_WINDOW_SIZE[dimension]
    ) {
      throw new Error(`Packaged window is below its configured minimum ${dimension}`);
    }
  }

  if (
    layout.contentBounds.width > layout.windowBounds.width
    || layout.contentBounds.height > layout.windowBounds.height
  ) {
    throw new Error('Packaged native content bounds exceed the native window bounds');
  }
  const nativeChrome = {
    width: layout.windowBounds.width - layout.contentBounds.width,
    height: layout.windowBounds.height - layout.contentBounds.height,
  };
  if (
    layout.viewport.width !== layout.windowBounds.width - nativeChrome.width
    || layout.viewport.height !== layout.windowBounds.height - nativeChrome.height
  ) {
    throw new Error('Packaged renderer viewport does not match the actual native content bounds');
  }

  if (layout.logo.height < 18 || layout.logo.height > 22 || layout.logo.width < 40 || layout.logo.width > 100) {
    throw new Error(`Packaged title-bar logo has unreasonable bounds: ${JSON.stringify(layout.logo)}`);
  }
  if (
    layout.logo.top < layout.titlebar.top
    || layout.logo.bottom > layout.titlebar.bottom
    || layout.card.left < 0
    || layout.card.right > layout.viewport.width
    || layout.card.top < layout.titlebar.bottom
    || layout.card.bottom > layout.viewport.height
  ) {
    throw new Error('Packaged logo or connection card extends outside its layout container');
  }
  for (const name of ['connectionName', 'apiUrl', 'submit']) {
    const control = layout[name];
    if (control.height < 36 || control.left < layout.card.left || control.right > layout.card.right) {
      throw new Error(`Packaged ${name} control has unreasonable bounds: ${JSON.stringify(control)}`);
    }
  }
  assertGap(layout.connectionName, layout.apiUrl, 28, 'between connection inputs');
  assertGap(layout.apiUrl, layout.apiHelp, 6, 'between API input and help text');
  assertGap(layout.apiHelp, layout.submit, 16, 'between API help and submit button');
  assertGap(layout.submit, layout.footer, 20, 'between submit button and runtime footer');
};

const ensurePrivateDirectory = async path => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Packaged smoke private profile layout is invalid');
  }
};

export const createPrivateSmokeProfile = async (temporaryDirectory = tmpdir()) => {
  const root = await mkdtemp(join(resolve(temporaryDirectory), PRIVATE_SMOKE_PREFIX));
  try {
    await ensurePrivateDirectory(root);
    const profile = {
      root,
      userData: root,
      home: join(root, 'home'),
      userProfile: join(root, 'profile'),
      appData: join(root, 'profile', 'AppData', 'Roaming'),
      localAppData: join(root, 'profile', 'AppData', 'Local'),
      temporary: join(root, 'temp'),
      xdgConfig: join(root, 'xdg', 'config'),
      xdgCache: join(root, 'xdg', 'cache'),
      xdgData: join(root, 'xdg', 'data'),
      xdgRuntime: join(root, 'xdg', 'runtime'),
    };
    for (const path of [
      profile.home,
      profile.userProfile,
      dirname(profile.appData),
      profile.appData,
      profile.localAppData,
      profile.temporary,
      dirname(profile.xdgConfig),
      profile.xdgConfig,
      profile.xdgCache,
      profile.xdgData,
      profile.xdgRuntime,
    ]) {
      const pathFromRoot = relative(root, path);
      if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
        throw new Error('Packaged smoke private profile path escaped its root');
      }
      await ensurePrivateDirectory(path);
    }
    const result = Object.freeze(profile);
    createdProfiles.add(result);
    return result;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

export const removePrivateSmokeProfile = async profile => {
  if (!profile || !createdProfiles.has(profile)) {
    throw new Error('Packaged smoke cleanup rejected an unknown profile');
  }
  createdProfiles.delete(profile);
  await rm(profile.root, { recursive: true, force: true });
};

const validateProfileApiUrl = value => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Packaged smoke profile API trigger is invalid');
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || value !== url.origin
  ) {
    throw new Error('Packaged smoke profile API trigger is invalid');
  }
  return value;
};

const validateDisplay = value => {
  if (
    typeof value !== 'string'
    || value.length > 128
    || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,126})?)?:[0-9]{1,5}(?:\.[0-9]{1,5})?$/.test(value)
  ) {
    throw new Error('Packaged smoke X display input is invalid');
  }
  return value;
};

const validateXAuthority = async (value, inspectPath) => {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) {
    throw new Error('Packaged smoke X authority input is invalid');
  }
  const stats = await inspectPath(value);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < 0
    || stats.size > MAX_XAUTHORITY_BYTES
    || (expectedUid !== undefined && stats.uid !== expectedUid)
    || (typeof stats.mode === 'number' && (stats.mode & 0o077) !== 0)
  ) {
    throw new Error('Packaged smoke X authority input is invalid');
  }
  return value;
};

export const validateWindowsSystemRoot = async (value, inspectPath = lstat) => {
  const driveCode = typeof value === 'string' ? value.charCodeAt(0) : -1;
  if (
    typeof value !== 'string'
    || value.length > 260
    || !(
      (driveCode >= 65 && driveCode <= 90)
      || (driveCode >= 97 && driveCode <= 122)
    )
    || value[1] !== ':'
    || value[2] !== '\\'
    || value.includes('\0')
    || value.includes('/')
    || value.slice(3).split('\\').some(segment => segment.length === 0)
    || !win32.isAbsolute(value)
    || win32.normalize(value) !== value
  ) {
    throw new Error('Packaged smoke Windows system root is invalid');
  }
  const stats = await inspectPath(value);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Packaged smoke Windows system root is invalid');
  }
  return value;
};

export const createSmokeChildEnvironment = async ({
  platform = process.platform,
  profile,
  profileApiUrl,
  parentEnvironment = process.env,
  inspectPath = lstat,
}) => {
  if (!profile || !createdProfiles.has(profile)) {
    throw new Error('Packaged smoke child environment rejected an unknown profile');
  }

  const triggers = {
    PROPR_DESKTOP_SMOKE_PROFILE_API_URL: validateProfileApiUrl(profileApiUrl),
    PROPR_DESKTOP_SMOKE_TEST: '1',
  };
  if (platform === 'win32') {
    return Object.freeze({
      APPDATA: profile.appData,
      LOCALAPPDATA: profile.localAppData,
      ...triggers,
      SystemRoot: await validateWindowsSystemRoot(parentEnvironment.SystemRoot, inspectPath),
      TEMP: profile.temporary,
      TMP: profile.temporary,
      USERPROFILE: profile.userProfile,
    });
  }
  if (platform === 'linux') {
    return Object.freeze({
      DISPLAY: validateDisplay(parentEnvironment.DISPLAY),
      HOME: profile.home,
      ...triggers,
      TEMP: profile.temporary,
      TMP: profile.temporary,
      TMPDIR: profile.temporary,
      XAUTHORITY: await validateXAuthority(parentEnvironment.XAUTHORITY, inspectPath),
      XDG_CACHE_HOME: profile.xdgCache,
      XDG_CONFIG_HOME: profile.xdgConfig,
      XDG_DATA_HOME: profile.xdgData,
      XDG_RUNTIME_DIR: profile.xdgRuntime,
    });
  }
  if (platform === 'darwin') {
    return Object.freeze({
      HOME: profile.home,
      ...triggers,
      TEMP: profile.temporary,
      TMP: profile.temporary,
      TMPDIR: profile.temporary,
    });
  }
  throw new Error('Packaged smoke child environment does not support this platform');
};
