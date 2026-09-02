import { randomBytes } from 'node:crypto';
import { BrowserWindow, crashReporter, type Session } from 'electron';
import { DESKTOP_RENDERER_ORIGIN, DESKTOP_TRANSPORT_SCOPE_HEADER } from '@propr/shared';
import type { DesktopCredentialService } from './credential-service';
import { clearDesktopInstanceCookies } from './desktop-session';
import type { ProfileStore } from './profile-store';
import { normalizeApiBaseUrl } from './security';
import {
  validatePackagedCurrentUserBoundaryEvidence,
  validatePackagedStaleSocketBoundaryEvidence,
  type PackagedSmokeCurrentUserEvidenceBuffer,
  type PackagedSmokeHandshakeEvidenceBuffer,
} from './smoke-test-evidence';

export interface PackagedTransportSmoke {
  firstOrigin: string;
  secondOrigin: string;
  shutdownMode: 'success' | 'retry' | 'forced-timeout';
}

export const packagedTransportSmoke = (authorized: boolean): PackagedTransportSmoke | null => {
  const raw = [
    process.env.PROPR_DESKTOP_SMOKE_FIRST_ORIGIN,
    process.env.PROPR_DESKTOP_SMOKE_SECOND_ORIGIN,
    process.env.PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE,
  ];
  if (raw.every(value => value === undefined)) return null;
  if (!authorized || raw.some(value => value === undefined)) {
    throw new Error('Packaged transport smoke inputs require an authorized complete smoke invocation');
  }
  const firstOrigin = normalizeApiBaseUrl(raw[0]!);
  const secondOrigin = normalizeApiBaseUrl(raw[1]!);
  const shutdownMode = raw[2];
  const loopback = (origin: string | null): origin is string => origin !== null
    && new URL(origin).hostname === '127.0.0.1';
  if (!loopback(firstOrigin) || !loopback(secondOrigin) || firstOrigin === secondOrigin
    || (shutdownMode !== 'success' && shutdownMode !== 'retry' && shutdownMode !== 'forced-timeout')) {
    throw new Error('Packaged transport smoke requires distinct canonical loopback fixtures and a bounded shutdown mode');
  }
  return { firstOrigin, secondOrigin, shutdownMode };
};

interface RunPackagedTransportSmokeOptions {
  window: BrowserWindow;
  profiles: ProfileStore;
  credentials: DesktopCredentialService;
  desktopSession: Session;
  smoke: PackagedTransportSmoke;
  handshakeEvidence: PackagedSmokeHandshakeEvidenceBuffer;
  currentUserEvidence: PackagedSmokeCurrentUserEvidenceBuffer;
  log(event: string, fields: Record<string, unknown>): void;
}

/** Execute transport and custody evidence against the actual packaged renderer and Electron session. */
export const runPackagedTransportSmoke = async ({
  window,
  profiles,
  credentials,
  desktopSession,
  smoke,
  handshakeEvidence,
  currentUserEvidence,
  log,
}: RunPackagedTransportSmokeOptions): Promise<void> => {
  const profileId = 'packaged-transport-smoke';
  const tokenA = `propr_it_${randomBytes(32).toString('base64url')}`;
  const tokenB = `propr_it_${randomBytes(32).toString('base64url')}`;
  const security = profiles.security();
  if (!security.available || security.backend === 'basic_text') {
    throw new Error('Packaged transport smoke requires the production OS credential backend');
  }
  const waitForCurrentUserEvidence = async (expected: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (currentUserEvidence.records.length < expected && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    if (currentUserEvidence.records.length !== expected || currentUserEvidence.overflowed) {
      throw new Error('Packaged current-user main-boundary evidence count was invalid');
    }
  };
  const profileA = await profiles.save({
    id: profileId, label: 'Packaged transport A', apiBaseUrl: smoke.firstOrigin,
  });
  const storedA = await profiles.writeCredential({
    version: 1, profileId, origin: smoke.firstOrigin, token: tokenA,
  });
  if (!storedA.stored) throw new Error('Production credential encryption was unavailable');

  const storageWindows = await Promise.all([
    { name: 'first' as const, origin: smoke.firstOrigin },
    { name: 'second' as const, origin: smoke.secondOrigin },
  ].map(async fixture => {
    const storageWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    await storageWindow.loadURL(`${fixture.origin}/smoke-storage`);
    return { ...fixture, window: storageWindow };
  }));
  const seedStorage = async (): Promise<void> => {
    await Promise.all(storageWindows.map(item => item.window.webContents.executeJavaScript(`(async () => {
      localStorage.setItem('packaged-smoke-local', 'present');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('packaged-smoke-indexeddb', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('proof');
        request.onsuccess = () => { request.result.close(); resolve(true); };
        request.onerror = () => reject(request.error);
      });
      const cache = await caches.open('packaged-smoke-cache');
      await cache.put('/packaged-smoke-cache-entry', new Response('present'));
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (!registrations.some(registration => registration.scope.startsWith(location.origin))) {
        await navigator.serviceWorker.register('/smoke-sw.js');
        await navigator.serviceWorker.ready;
      }
      document.cookie = 'packaged-smoke-cookie=present; SameSite=Lax';
      return true;
    })()`)));
  };
  const storageState = async (expected: Readonly<Record<'first' | 'second', 'present' | 'absent'>>): Promise<boolean> => {
    const states = await Promise.all(storageWindows.map(async item => {
      const rendererState = await item.window.webContents.executeJavaScript(`(async () => ({
        cookie: document.cookie.includes('packaged-smoke-cookie=present'),
        localStorage: localStorage.getItem('packaged-smoke-local') === 'present',
        indexedDB: (await indexedDB.databases()).some(database => database.name === 'packaged-smoke-indexeddb'),
        cacheStorage: (await caches.keys()).includes('packaged-smoke-cache'),
        serviceWorker: (await navigator.serviceWorker.getRegistrations()).some(registration => registration.scope.startsWith(location.origin)),
      }))()`);
      const cookies = await desktopSession.cookies.get({ url: item.origin });
      const expectedPresent = expected[item.name] === 'present';
      const cookieMatches = expectedPresent
        ? rendererState.cookie === true
          && cookies.some(cookie => cookie.name === 'packaged-smoke-cookie' && cookie.value === 'present')
        : rendererState.cookie === false && cookies.length === 0;
      return cookieMatches
        && ['localStorage', 'indexedDB', 'cacheStorage', 'serviceWorker']
          .every(storageType => rendererState[storageType] === expectedPresent);
    }));
    return states.every(Boolean);
  };
  const bothOriginsPresent = { first: 'present', second: 'present' } as const;
  const activationCleanupSplit = { first: 'absent', second: 'present' } as const;
  const bothOriginsAbsent = { first: 'absent', second: 'absent' } as const;

  try {
    // Both fixture origins must be populated while no renderer credential
    // binding is active. Once activation publishes a binding, production
    // correctly restricts renderer network traffic to that exact origin.
    await seedStorage();
    if (!await storageState(bothOriginsPresent)) {
      throw new Error('Packaged preactivation origin storage fixture was incomplete');
    }

    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (window.__proprPackagedTransportSmoke) return resolve(true);
        if (Date.now() - started > 5000) return reject(new Error('Packaged renderer smoke harness timed out'));
        setTimeout(poll, 20);
      };
      poll();
    })`);
    const profileForRendererA = {
      id: profileId, name: profileA.label, baseUrl: smoke.firstOrigin, kind: 'remote',
    };
    const first = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const first = await smoke.activate(${JSON.stringify(profileForRendererA)});
      await smoke.rest();
      const socketId = await smoke.connectSocket();
      const rotated = await smoke.activate(${JSON.stringify(profileForRendererA)});
      let staleRestRejected = false;
      try {
        const response = await fetch(${JSON.stringify(`${smoke.firstOrigin}/api/smoke/rest`)}, {
          headers: { ${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_HEADER)}: first.transportScope },
          credentials: 'include',
        });
        staleRestRejected = !response.ok;
      } catch { staleRestRejected = true; }
      return { first, rotated, socketId, staleRestRejected, rendererOrigin: location.origin };
    })()`);
    if (first?.rendererOrigin !== DESKTOP_RENDERER_ORIGIN || first?.first?.profileId !== profileId
      || first?.first?.transportScope === first?.rotated?.transportScope
      || first?.first?.contractsContainSecret !== false || first?.rotated?.contractsContainSecret !== false
      || first?.staleRestRejected !== true) {
      throw new Error('Packaged renderer protocol or first transport proof failed');
    }
    await waitForCurrentUserEvidence(2);
    const staleAttemptEvidenceStart = handshakeEvidence.records.length;
    const staleAttemptResult = await window.webContents.executeJavaScript(`
      window.__proprPackagedTransportSmoke.expectSocketRejected(${JSON.stringify(first.socketId)})
    `);
    const staleAttemptEvidence = handshakeEvidence.records.slice(staleAttemptEvidenceStart);
    const staleBoundarySummary = validatePackagedStaleSocketBoundaryEvidence(
      staleAttemptEvidence,
      handshakeEvidence.overflowed,
    );
    if (staleAttemptResult?.transportRejected !== true
      || staleAttemptResult?.freshManagerConnected !== true) {
      throw new Error('Packaged stale Socket.IO renderer-boundary evidence failed');
    }
    log('desktop.transport_smoke.stale_socket_boundary', { ...staleBoundarySummary });
    await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      await smoke.rest();
      localStorage.setItem('packaged-smoke-local', 'non-secret sentinel');
      sessionStorage.setItem('packaged-smoke-session', 'non-secret sentinel');
    })()`);
    if (!await storageState(activationCleanupSplit)) {
      throw new Error('Packaged activation did not clear only the activated origin storage');
    }

    // These isolated fixture WebContents are not the trusted main renderer, so
    // they can reseed both foreign origins without receiving renderer credentials.
    await seedStorage();
    if (!await storageState(bothOriginsPresent)) {
      throw new Error('Packaged credentialless origin storage reseed was incomplete');
    }

    let cleanupFailed = false;
    try {
      await credentials.saveProfile({
        id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
      }, async () => { throw new Error('packaged cleanup failure'); });
    } catch (error) {
      cleanupFailed = error instanceof Error && error.message === 'packaged cleanup failure';
    }
    const rollback = await profiles.readProfileCredential(profileId);
    if (!cleanupFailed || rollback.profile?.apiBaseUrl !== smoke.firstOrigin
      || rollback.credential?.origin !== smoke.firstOrigin || rollback.credential.token !== tokenA
      || !await storageState(bothOriginsPresent)) {
      throw new Error('Origin cleanup failure did not preserve complete durable A');
    }
    let precommitStorageCleared = false;
    await credentials.saveProfile({
      id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
    }, async (previousOrigin, nextOrigin) => {
      await clearDesktopInstanceCookies(desktopSession, [previousOrigin, nextOrigin]);
      precommitStorageCleared = await storageState(bothOriginsAbsent);
      if (!precommitStorageCleared) throw new Error('Complete origin storage was not cleared before commit');
    });
    if (!precommitStorageCleared || !await storageState(bothOriginsAbsent)) {
      throw new Error('Same-ID URL edit did not clear both complete Electron origin stores');
    }
    const storedB = await profiles.writeCredential({
      version: 1, profileId, origin: smoke.secondOrigin, token: tokenB,
    });
    if (!storedB.stored) throw new Error('Replacement credential encryption was unavailable');

    const profileForRendererB = {
      id: profileId, name: 'Packaged transport B', baseUrl: smoke.secondOrigin, kind: 'remote',
    };
    const second = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const activated = await smoke.activate(${JSON.stringify(profileForRendererB)});
      const socketId = await smoke.connectSocket();
      await smoke.reconnectSocket(socketId);
      const staleClassification = await smoke.handleStaleInvalidation(
        ${JSON.stringify(profileId)}, ${JSON.stringify(first.rotated.transportScope)}
      );
      smoke.disconnectSocket(${JSON.stringify(first.socketId)});
      await smoke.rest();
      const persisted = await window.__PROPR_DESKTOP__.profiles.list();
      const rendererEvidence = smoke.rendererEvidence();
      return {
        activated,
        staleClassification,
        persisted,
        rendererEvidence,
        rendererPersistenceContainsSecret: JSON.stringify([persisted, rendererEvidence]).includes('propr_it_'),
      };
    })()`);
    const secretInMainMetadata = [tokenA, tokenB].some(secret =>
      process.argv.some(argument => argument.includes(secret))
      || JSON.stringify(crashReporter.getParameters()).includes(secret));
    if (second?.staleClassification !== 'retryable' || second?.activated?.profileId !== profileId
      || second?.activated?.contractsContainSecret !== false
      || second?.rendererPersistenceContainsSecret !== false || secretInMainMetadata) {
      throw new Error('Packaged replacement scope or secret-custody proof failed');
    }
    await waitForCurrentUserEvidence(3);
    log('desktop.renderer.transport_smoke.current_user', {
      ...validatePackagedCurrentUserBoundaryEvidence(
        currentUserEvidence.records,
        currentUserEvidence.overflowed,
      ),
    });
    log('desktop.renderer.transport_smoke.ready', {
      customProtocol: true,
      restBearer: true,
      socketIo: true,
      engineIoHandshake: true,
      namespaceAuthentication: true,
      reconnectAndErrorHandling: true,
      scopeRotation: true,
      allOriginStorageCleared: true,
      cleanupRollbackAndRetry: true,
      staleScopeRejected: true,
      secretCustody: true,
      productionCredentialRoundTrip: true,
      storageBackend: security.backend,
    });
  } finally {
    for (const item of storageWindows) if (!item.window.isDestroyed()) item.window.destroy();
  }
};
