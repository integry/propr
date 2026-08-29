import { evaluateProprApiCompatibility } from '@propr/shared';
import type {
  DesktopAdapters,
  DesktopAuthenticationCompleteEventDetail,
  DesktopConnectionResult,
  DesktopPlatform,
  DesktopProfile,
  ProprDesktopBridge,
} from './types';
import { DESKTOP_AUTHENTICATION_COMPLETE_EVENT } from './types';

const PROFILES_KEY = 'propr.desktop.profiles';
const ACTIVE_PROFILE_KEY = 'propr.desktop.activeProfile';
const FIXTURE_QUERY_KEY = 'desktop-fixture';
const AUTHENTICATION_TIMEOUT_MS = 5 * 60_000;

type DesktopFixture = 'first-run' | 'recents' | 'offline' | 'incompatible' | 'connected';

const fixtureProfile: DesktopProfile = {
  id: 'fixture-local',
  name: 'This computer',
  baseUrl: 'http://127.0.0.1:3000',
  kind: 'local',
  lastConnectedAt: '2026-08-29T12:00:00.000Z',
};

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Instance URLs must use http:// or https://.');
  }
  if (url.username || url.password) throw new Error('Instance URLs cannot contain credentials.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

const readProfiles = (): DesktopProfile[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROFILES_KEY) || '[]') as unknown;
    return Array.isArray(value) ? value.filter(isDesktopProfile) : [];
  } catch {
    return [];
  }
};

const isDesktopProfile = (value: unknown): value is DesktopProfile => {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<DesktopProfile>;
  return typeof profile.id === 'string'
    && typeof profile.name === 'string'
    && typeof profile.baseUrl === 'string'
    && (profile.kind === 'local' || profile.kind === 'remote');
};

const saveProfiles = (profiles: DesktopProfile[]): void => {
  window.localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
};

const detectPlatform = (): DesktopPlatform => {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  return 'linux';
};

const fixtureFromLocation = (): DesktopFixture | null => {
  const fixture = new URLSearchParams(window.location.search).get(FIXTURE_QUERY_KEY);
  return fixture === 'first-run' || fixture === 'recents' || fixture === 'offline'
    || fixture === 'incompatible' || fixture === 'connected'
    ? fixture
    : null;
};

const probeProfile = async (profile: DesktopProfile): Promise<DesktopConnectionResult> => {
  try {
    const response = await fetch(`${normalizeBaseUrl(profile.baseUrl)}/api/compatibility`, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'authentication-required', message: 'Sign in to continue to this instance.' };
    }
    if (response.status === 404) return { status: 'ready' };
    if (!response.ok) return { status: 'offline', message: `The instance returned HTTP ${response.status}.` };
    const metadata = await response.json() as { apiCompatibility?: string; version?: string };
    const compatibility = evaluateProprApiCompatibility(metadata);
    if (compatibility.compatible || compatibility.reason === 'missing') {
      return { status: 'ready', version: compatibility.apiVersion ?? undefined };
    }
    return {
      status: 'incompatible',
      message: compatibility.message,
      version: compatibility.apiVersion ?? undefined,
    };
  } catch {
    return { status: 'offline', message: 'ProPR could not reach this instance. Check that it is running and try again.' };
  }
};

const authenticateBrowserFixture = (profile: DesktopProfile): Promise<void> => new Promise((resolve, reject) => {
  const complete = (event: Event) => {
    const detail = (event as CustomEvent<DesktopAuthenticationCompleteEventDetail>).detail;
    if (detail?.profileId !== profile.id) return;
    cleanup();
    resolve();
  };
  const timeoutId = window.setTimeout(() => {
    cleanup();
    reject(new Error('GitHub sign-in timed out.'));
  }, AUTHENTICATION_TIMEOUT_MS);
  const cleanup = () => {
    window.clearTimeout(timeoutId);
    window.removeEventListener(DESKTOP_AUTHENTICATION_COMPLETE_EVENT, complete);
  };

  window.addEventListener(DESKTOP_AUTHENTICATION_COMPLETE_EVENT, complete);
  const redirect = new URL('propr://authentication-complete');
  redirect.searchParams.set('profile_id', profile.id);
  try {
    window.open(
      `${normalizeBaseUrl(profile.baseUrl)}/api/auth/github?redirect_to=${encodeURIComponent(redirect.toString())}`,
      '_blank',
      'noopener,noreferrer'
    );
  } catch (error) {
    cleanup();
    reject(error);
  }
});

const createBrowserAdapters = (fixture: DesktopFixture | null): DesktopAdapters => ({
  platform: detectPlatform(),
  profiles: {
    async list() {
      if (fixture === 'first-run') return [];
      if (fixture) return [fixtureProfile, { ...fixtureProfile, id: 'fixture-team', name: 'Team server', baseUrl: 'https://propr.example.test', kind: 'remote' }];
      return readProfiles();
    },
    async save(profile) {
      const normalized = { ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl) };
      saveProfiles([...readProfiles().filter(item => item.id !== profile.id), normalized]);
    },
    async remove(profileId) {
      saveProfiles(readProfiles().filter(profile => profile.id !== profileId));
      if (window.localStorage.getItem(ACTIVE_PROFILE_KEY) === profileId) {
        window.localStorage.removeItem(ACTIVE_PROFILE_KEY);
      }
    },
    async getActiveId() {
      if (fixture === 'connected') return fixtureProfile.id;
      return fixture ? null : window.localStorage.getItem(ACTIVE_PROFILE_KEY);
    },
    async setActiveId(profileId) {
      if (profileId) window.localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
      else window.localStorage.removeItem(ACTIVE_PROFILE_KEY);
    },
  },
  discovery: { async discover() { return fixture ? [fixtureProfile] : []; } },
  externalBrowser: { async open(url) { window.open(url, '_blank', 'noopener,noreferrer'); } },
  authentication: {
    authenticate: authenticateBrowserFixture,
  },
  localSetup: {
    async status() {
      return { phase: 'idle', capability: { supported: true, kind: 'local', platform: 'linux' }, logs: [] };
    },
    async start() { throw new Error('Local setup requires the Electron desktop host.'); },
    async retry() { throw new Error('Local setup requires the Electron desktop host.'); },
    async cancel() { return { phase: 'cancelled', capability: { supported: true, kind: 'local', platform: 'linux' }, logs: [] }; },
    onProgress() { return () => undefined; },
  },
  connection: {
    async probe(profile) {
      if (fixture === 'offline') return { status: 'offline', message: 'The instance is offline. Start it and try again.' };
      if (fixture === 'incompatible') return { status: 'incompatible', message: 'This instance requires a newer version of ProPR Desktop.', version: '0.7.0' };
      if (fixture) return { status: 'ready', version: '0.8.15' };
      return probeProfile(profile);
    },
  },
});

export const resolveDesktopAdapters = (): DesktopAdapters | null => {
  const bridge: ProprDesktopBridge | undefined = window.__PROPR_DESKTOP__;
  if (bridge?.isDesktop) return bridge;
  const fixture = import.meta.env.DEV ? fixtureFromLocation() : null;
  return fixture ? createBrowserAdapters(fixture) : null;
};

export { normalizeBaseUrl };
