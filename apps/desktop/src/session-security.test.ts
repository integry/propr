import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Session, WebContents, WebFrameMain } from 'electron';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import { DesktopCredentialService } from './credential-service';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import {
  configureDesktopSessionSecurity,
  desktopNetworkPermissionAllowed,
  type DesktopNetworkPermissionEvidence,
} from './session-security';

const RENDERER_URL = `${DESKTOP_RENDERER_ORIGIN}/renderer.html`;
const ACTIVE_ORIGIN = 'http://127.0.0.2:41731';
const TOKEN = `propr_it_${'T'.repeat(43)}`;
const IDENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};

const discovery = {
  schemaVersion: 1,
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  canonicalEndpoint: null,
  publicInstanceIdentity: IDENTITY,
  desktopAuthentication: {
    protocolVersion: 2,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};

describe('production desktop session security', () => {
  it('denies every permission except active trusted-main-frame local network access', () => {
    const accepted = {
      activeBindingCurrent: true,
      decision: 'check' as const,
      isMainFrame: true,
      mainWindowPresent: true,
      permission: 'loopback-network',
      rendererDocumentUrlTrusted: true,
      requestingOriginAuthorityEqual: true,
      requestingOriginAuthorityValid: true,
      requestingUrlAuthorityEqual: true,
      requestingUrlPresent: false,
      requestingUrlTrusted: false,
      webContentsEqualsMainWindow: false,
      webContentsPresent: false,
    };
    assert.equal(desktopNetworkPermissionAllowed(accepted), true);
    for (const rejected of [
      { activeBindingCurrent: false },
      { isMainFrame: false },
      { mainWindowPresent: false },
      { permission: 'notifications' },
      { rendererDocumentUrlTrusted: false },
      { requestingOriginAuthorityEqual: false },
      { requestingOriginAuthorityValid: false },
      { webContentsPresent: true },
    ]) {
      assert.equal(desktopNetworkPermissionAllowed({ ...accepted, ...rejected }), false);
    }
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'local-network' }), true);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'local-network-access' }), true);
    assert.equal(desktopNetworkPermissionAllowed({
      ...accepted,
      decision: 'request',
      requestingUrlPresent: true,
      requestingUrlTrusted: true,
      webContentsEqualsMainWindow: true,
      webContentsPresent: true,
    }), true);
  });

  it('pins permission and concrete credential transport to the live main renderer and current origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-session-security-'));
    const store = new ProfileStore(directory, encryption);
    let connectClaimCurrent = true;
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Session security test',
      openPairingBrowser: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? new Response(JSON.stringify(discovery), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ username: 'octocat' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      snapshotConnectIdentityClaim: () => ({
        status: 'unclaimed',
        isCurrent: () => connectClaimCurrent,
        beginCommit: () => () => undefined,
      }),
    });
    try {
      const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: ACTIVE_ORIGIN });
      await store.writeCredential({
        version: 2,
        profileId: profile.id,
        origin: ACTIVE_ORIGIN,
        publicInstanceIdentity: IDENTITY,
        token: TOKEN,
      });
      const ready = await service.probe(profile);
      assert.equal(ready.status, 'ready');
      if (ready.status !== 'ready') return;

      type PermissionCheck = (
        webContents: WebContents | null,
        permission: string,
        requestingOrigin: string,
        details: { requestingUrl?: string; isMainFrame: boolean },
      ) => boolean;
      type PermissionRequest = (
        webContents: WebContents,
        permission: string,
        callback: (allowed: boolean) => void,
        details: { requestingUrl?: string; isMainFrame: boolean },
      ) => void;
      type BeforeSendHeaders = (
        details: {
          url: string;
          method: string;
          resourceType: string;
          requestHeaders: Record<string, string>;
          webContentsId: number;
          webContents?: WebContents;
          frame?: WebFrameMain | null;
        },
        callback: (decision: Record<string, unknown>) => void,
      ) => void;
      let permissionCheck: PermissionCheck = () => false;
      let permissionRequest: PermissionRequest = () => undefined;
      let beforeSendHeaders: BeforeSendHeaders = () => undefined;
      const evidence: DesktopNetworkPermissionEvidence[] = [];
      const desktopSession = {
        setPermissionCheckHandler: (handler: PermissionCheck | null) => {
          if (handler) permissionCheck = handler;
        },
        setPermissionRequestHandler: (handler: PermissionRequest | null) => {
          if (handler) permissionRequest = handler;
        },
        webRequest: {
          onBeforeSendHeaders: (handler: BeforeSendHeaders | null) => {
            if (handler) beforeSendHeaders = handler;
          },
          onHeadersReceived: () => undefined,
        },
      } as unknown as Session;
      let destroyed = false;
      let rendererUrl = RENDERER_URL;
      const mainFrame = {
        detached: false,
        parent: null,
        url: RENDERER_URL,
      } as unknown as WebFrameMain;
      const mainRenderer = {
        id: 41,
        getURL: () => rendererUrl,
        isDestroyed: () => destroyed,
        mainFrame,
      } as unknown as WebContents;
      const foreignRenderer = {
        id: 42,
        getURL: () => RENDERER_URL,
        isDestroyed: () => false,
      } as unknown as WebContents;
      configureDesktopSessionSecurity({
        contentSecurityPolicy: () => "default-src 'self'",
        credentials: service,
        desktopSession,
        getMainRenderer: () => mainRenderer,
        isTrustedRendererUrl: value => value === RENDERER_URL,
        reportNetworkPermissionDecision: record => evidence.push(record),
      });

      const check = (
        webContents: WebContents | null = null,
        origin = DESKTOP_RENDERER_ORIGIN,
        details: { requestingUrl?: string; isMainFrame: boolean } = { isMainFrame: true },
      ) => permissionCheck(webContents, 'loopback-network', origin, details);
      assert.equal(check(), false);
      const activated = await service.activate(ready.activationTicket);
      assert.equal(check(), true);
      assert.equal(check(foreignRenderer, DESKTOP_RENDERER_ORIGIN, {
        requestingUrl: RENDERER_URL,
        isMainFrame: true,
      }), false);
      assert.equal(check(null, 'https://attacker.example.test'), false);
      assert.equal(check(null, DESKTOP_RENDERER_ORIGIN, { isMainFrame: false }), false);
      rendererUrl = 'https://attacker.example.test/renderer.html';
      assert.equal(check(), false);
      rendererUrl = RENDERER_URL;
      destroyed = true;
      assert.equal(check(), false);
      destroyed = false;

      let requested = false;
      permissionRequest(mainRenderer, 'local-network-access', value => { requested = value; }, {
        requestingUrl: RENDERER_URL,
        isMainFrame: true,
      });
      assert.equal(requested, true);
      permissionRequest(foreignRenderer, 'local-network-access', value => { requested = value; }, {
        requestingUrl: RENDERER_URL,
        isMainFrame: true,
      });
      assert.equal(requested, false);

      const intercepted = async (
        url: string,
        headers: Record<string, string>,
        webContentsId = mainRenderer.id,
        resourceType = 'xhr',
        frame: WebFrameMain | null = mainFrame,
      ) => await new Promise<Record<string, unknown>>(resolve => beforeSendHeaders({
        url,
        method: 'GET',
        resourceType,
        requestHeaders: headers,
        webContentsId,
        frame,
      }, resolve));
      const scopeHeaders = {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Authorization: 'Bearer renderer-controlled',
        Cookie: 'renderer=must-not-cross',
        [DESKTOP_TRANSPORT_SCOPE_HEADER]: activated.transportScope,
      };
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders), {
        requestHeaders: {
          Origin: DESKTOP_RENDERER_ORIGIN,
          Authorization: `Bearer ${TOKEN}`,
        },
      });
      assert.deepEqual(await intercepted(
        `${ACTIVE_ORIGIN}/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`,
        scopeHeaders,
        mainRenderer.id,
        'mainFrame',
      ), { cancel: true });
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders, foreignRenderer.id), {
        cancel: true,
      });
      const childFrame = {
        detached: false,
        parent: mainFrame,
        url: RENDERER_URL,
      } as unknown as WebFrameMain;
      assert.deepEqual(await intercepted(
        `${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders, mainRenderer.id, 'xhr', childFrame,
      ), { cancel: true });
      const foreignDocument = {
        detached: false,
        parent: null,
        url: 'https://attacker.example.test/renderer.html',
      } as unknown as WebFrameMain;
      assert.deepEqual(await intercepted(
        `${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders, mainRenderer.id, 'xhr', foreignDocument,
      ), { cancel: true });
      for (const target of [
        'http://127.0.0.1:41731/api/side-effect',
        'http://127.0.0.3:41731/api/side-effect',
        'https://192.168.1.10/api/side-effect',
      ]) {
        assert.deepEqual(await intercepted(target, {
          Authorization: 'Bearer renderer-controlled',
          Cookie: 'renderer=must-not-cross',
        }), { cancel: true }, target);
      }
      connectClaimCurrent = false;
      assert.equal(check(), false);
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders), { cancel: true });
      connectClaimCurrent = true;
      assert.equal(check(), true);
      destroyed = true;
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/auth/user`, scopeHeaders), { cancel: true });
      destroyed = false;

      assert.deepEqual(await service.discardActivation(activated), { discarded: true });
      assert.equal(check(), false);
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/side-effect`, {
        Authorization: 'Bearer renderer-controlled',
        Cookie: 'renderer=must-not-cross',
      }), { cancel: true });

      const revokedReady = await service.probe(profile);
      assert.equal(revokedReady.status, 'ready');
      if (revokedReady.status !== 'ready') return;
      const revoked = await service.activate(revokedReady.activationTicket);
      assert.deepEqual(await service.invalidate({
        profileId: profile.id,
        transportScope: revoked.transportScope,
        code: 'INSTANCE_TOKEN_REVOKED',
      }), { invalidated: true });
      assert.equal(check(), false);
      assert.deepEqual(await intercepted(`${ACTIVE_ORIGIN}/api/side-effect`, {}), { cancel: true });

      assert.ok(evidence.length >= 10);
      assert.doesNotMatch(
        JSON.stringify(evidence),
        /attacker|renderer\.html|127\.0\.0\.2|192\.168|propr_it_/u,
      );
      assert.ok(evidence.every(record => Object.keys(record).sort().join(',') === [
        'activeBindingCurrent', 'allowed', 'decision', 'isMainFrame', 'mainWindowPresent',
        'permissionCategory', 'rendererDocumentUrlTrusted', 'requestingOriginAuthorityEqual',
        'requestingOriginAuthorityValid', 'requestingUrlPresent', 'requestingUrlTrusted',
        'schemaVersion', 'webContentsEqualsMainWindow', 'webContentsPresent',
      ].sort().join(',')));
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
