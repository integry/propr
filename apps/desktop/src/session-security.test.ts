import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Session, WebContents } from 'electron';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  DesktopCredentialService,
  type DesktopCurrentUserProxyEvidence,
} from './credential-service';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import {
  configureDesktopSessionSecurity,
  desktopNetworkPermissionAllowed,
  type DesktopNetworkPermissionEvidence,
} from './session-security';

const RENDERER_URL = `${DESKTOP_RENDERER_ORIGIN}/renderer.html`;
// Acceptance uses an address distinct from the standard smoke's 127.0.0.1.
const REACT_FIXTURE_ORIGIN = 'http://127.0.0.2:41731';
const TOKEN = `propr_it_${'T'.repeat(43)}`;

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};

describe('production desktop session security', () => {
  it('denies every permission except active trusted-renderer local network access', () => {
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
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, activeBindingCurrent: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'notifications' }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, isMainFrame: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, rendererDocumentUrlTrusted: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, requestingOriginAuthorityEqual: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, requestingOriginAuthorityValid: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({
      ...accepted,
      requestingUrlPresent: true,
      requestingUrlTrusted: false,
    }), false);
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
    assert.equal(desktopNetworkPermissionAllowed({
      ...accepted,
      decision: 'request',
      requestingUrlPresent: true,
      requestingUrlTrusted: true,
    }), false);
  });

  it('limits credential transport to the exact live main renderer and active origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-session-security-'));
    const store = new ProfileStore(directory, encryption);
    const mainEvidence: DesktopCurrentUserProxyEvidence[] = [];
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Session security test',
      openExternal: async () => undefined,
      reportCurrentUserValidation: evidence => mainEvidence.push(evidence),
      fetch: async input => new URL(input.toString()).pathname === '/api/desktop/discovery'
        ? new Response(JSON.stringify({
          product: 'ProPR',
          version: '0.8.15',
          apiCompatibility: PROPR_API_COMPATIBILITY,
          uiCompatibility: PROPR_UI_COMPATIBILITY,
          desktopAuthentication: {
            protocolVersion: 2,
            browserPairing: true,
            instanceBearerTokens: true,
            socketIoBearerAuthentication: true,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    try {
      const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: REACT_FIXTURE_ORIGIN });
      await store.writeCredential({ version: 1, profileId: profile.id, origin: REACT_FIXTURE_ORIGIN, token: TOKEN });
      const probed = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: REACT_FIXTURE_ORIGIN });
      assert.equal(probed.status, 'ready');
      if (probed.status !== 'ready' || !probed.activationTicket) return;

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
        },
        callback: (decision: Record<string, unknown>) => void,
      ) => void;
      let permissionCheck: PermissionCheck = () => { throw new Error('Permission check was not installed'); };
      let permissionRequest: PermissionRequest = () => { throw new Error('Permission request was not installed'); };
      let beforeSendHeaders: BeforeSendHeaders = () => { throw new Error('Request interceptor was not installed'); };
      const permissionEvidence: DesktopNetworkPermissionEvidence[] = [];
      const desktopSession = {
        setPermissionCheckHandler: (listener: PermissionCheck | null) => {
          if (listener) permissionCheck = listener;
        },
        setPermissionRequestHandler: (listener: PermissionRequest | null) => {
          if (listener) permissionRequest = listener;
        },
        webRequest: {
          onBeforeSendHeaders: (listener: BeforeSendHeaders | null) => {
            if (listener) beforeSendHeaders = listener;
          },
          onHeadersReceived: (_listener: unknown) => undefined,
        },
      } as unknown as Session;
      let mainRendererDestroyed = false;
      const mainRenderer = {
        id: 41,
        getURL: () => RENDERER_URL,
        isDestroyed: () => mainRendererDestroyed,
      } as unknown as WebContents;
      const otherRenderer = { id: 42, getURL: () => RENDERER_URL } as unknown as WebContents;
      const configured = configureDesktopSessionSecurity({
        contentSecurityPolicy: () => "default-src 'self'",
        credentials: service,
        desktopSession,
        getMainRenderer: () => mainRenderer,
        isTrustedRendererUrl: value => value === RENDERER_URL,
        reportNetworkPermissionDecision: evidence => permissionEvidence.push(evidence),
      });

      const beforeActivation = async (
        url: string,
        headers: Record<string, string>,
        webContentsId: number,
        resourceType = 'xhr',
      ) => await new Promise<Record<string, unknown>>(resolve => beforeSendHeaders({
        url,
        method: 'GET',
        resourceType,
        requestHeaders: headers,
        webContentsId,
      }, resolve));
      assert.deepEqual(await beforeActivation(
        'http://127.0.0.1:41731/smoke-sw.js',
        {
          Accept: 'application/javascript',
          Authorization: 'Bearer foreign-controlled',
          Cookie: 'foreign=session',
        },
        otherRenderer.id,
        'script',
      ), {
        requestHeaders: { Accept: 'application/javascript' },
      });
      assert.deepEqual(await beforeActivation(`${REACT_FIXTURE_ORIGIN}/api/side-effect`, {
        Origin: DESKTOP_RENDERER_ORIGIN,
      }, mainRenderer.id), { cancel: true });
      mainRendererDestroyed = true;
      assert.deepEqual(await beforeActivation('http://127.0.0.1:41731/storage-fixture.html', {
        Authorization: 'Bearer destroyed-renderer',
        Cookie: 'destroyed=session',
      }, mainRenderer.id), { requestHeaders: {} });
      mainRendererDestroyed = false;

      const activated = await service.activate(probed.activationTicket);

      // Electron documents a nullable WebContents for permission checks. The
      // trusted main-frame authority remains sufficient without fabricating it.
      assert.equal(permissionCheck(
        null,
        'loopback-network',
        DESKTOP_RENDERER_ORIGIN,
        { isMainFrame: true },
      ), true);
      assert.equal(permissionCheck(null, 'loopback-network', DESKTOP_RENDERER_ORIGIN, {
        isMainFrame: false,
      }), false);
      assert.equal(permissionCheck(null, 'loopback-network', 'https://attacker.example.test', {
        isMainFrame: true,
      }), false);
      assert.equal(permissionCheck(null, 'loopback-network', '', {
        isMainFrame: true,
      }), false);
      assert.equal(permissionCheck(null, 'loopback-network', DESKTOP_RENDERER_ORIGIN, {
        requestingUrl: 'https://attacker.example.test/frame', isMainFrame: true,
      }), false);
      assert.equal(permissionCheck(otherRenderer, 'loopback-network', DESKTOP_RENDERER_ORIGIN, {
        requestingUrl: RENDERER_URL, isMainFrame: true,
      }), false);
      assert.equal(permissionCheck(null, 'notifications', DESKTOP_RENDERER_ORIGIN, {
        isMainFrame: true,
      }), false);
      let requestedPermission = false;
      permissionRequest(
        mainRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { requestingUrl: RENDERER_URL, isMainFrame: true },
      );
      assert.equal(requestedPermission, true);
      permissionRequest(
        otherRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { requestingUrl: RENDERER_URL, isMainFrame: true },
      );
      assert.equal(requestedPermission, false);
      permissionRequest(
        mainRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { isMainFrame: true },
      );
      assert.equal(requestedPermission, false);
      permissionRequest(
        mainRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { requestingUrl: 'https://attacker.example.test/frame', isMainFrame: true },
      );
      assert.equal(requestedPermission, false);
      permissionRequest(
        mainRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { requestingUrl: RENDERER_URL, isMainFrame: false },
      );
      assert.equal(requestedPermission, false);
      assert.equal(permissionEvidence.length, 11);
      assert.deepEqual(permissionEvidence[0], {
        schemaVersion: 1,
        permissionCategory: 'loopback-network',
        decision: 'check',
        allowed: true,
        activeBindingCurrent: true,
        webContentsPresent: false,
        webContentsEqualsMainWindow: false,
        mainWindowPresent: true,
        isMainFrame: true,
        requestingUrlPresent: false,
        requestingUrlTrusted: false,
        rendererDocumentUrlTrusted: true,
        requestingOriginAuthorityValid: true,
        requestingOriginAuthorityEqual: true,
      });
      assert.doesNotMatch(JSON.stringify(permissionEvidence), /attacker|renderer\.html|127\.0\.0\.2|propr_it_/);

      const intercepted = async (
        url: string,
        method: 'OPTIONS' | 'GET',
        headers: Record<string, string>,
        resourceType = 'xhr',
        webContentsId = mainRenderer.id,
      ) => {
        return await new Promise<Record<string, unknown>>(resolve => beforeSendHeaders({
          url,
          method,
          resourceType,
          requestHeaders: headers,
          webContentsId,
        }, resolve));
      };
      const unrelatedTargets = [
        'http://127.0.0.1:41731/api/side-effect',
        'https://192.168.1.10/api/side-effect',
        'http://127.0.0.2:41732/api/side-effect',
        'https://127.0.0.2.evil.invalid:41731/api/side-effect',
      ];
      for (const url of unrelatedTargets) {
        assert.deepEqual(await intercepted(url, 'GET', {
          Origin: DESKTOP_RENDERER_ORIGIN,
        }), { cancel: true }, url);
      }

      const currentUserUrl = `${REACT_FIXTURE_ORIGIN}/api/auth/user?proprDesktopScopeGeneration=1`;
      assert.deepEqual(await intercepted(currentUserUrl, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Referer: RENDERER_URL,
        Authorization: 'Bearer foreign-controlled',
        Cookie: 'foreign=session',
        [DESKTOP_TRANSPORT_SCOPE_HEADER]: activated.transportScope,
      }, 'xhr', otherRenderer.id), { cancel: true });
      const preflight = await intercepted(currentUserUrl, 'OPTIONS', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': DESKTOP_TRANSPORT_SCOPE_HEADER,
      });
      assert.equal(preflight.cancel, undefined);
      assert.equal(new Headers(preflight.requestHeaders as HeadersInit).has('Authorization'), false);

      const get = await intercepted(currentUserUrl, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Cookie: 'renderer=must-not-cross',
        Authorization: 'Bearer renderer-controlled',
        [DESKTOP_TRANSPORT_SCOPE_HEADER]: activated.transportScope,
      });
      const outbound = new Headers(get.requestHeaders as HeadersInit);
      assert.equal(get.cancel, undefined);
      assert.deepEqual(get.requestHeaders, {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(outbound.get('Authorization'), `Bearer ${TOKEN}`);
      assert.equal(outbound.has('Cookie'), false);
      assert.equal(outbound.has(DESKTOP_TRANSPORT_SCOPE_HEADER), false);
      assert.equal(mainEvidence.length, 1);
      assert.equal(mainEvidence[0].accepted, true);
      assert.equal(mainEvidence[0].rendererScopeGeneration, 1);
      assert.equal(mainEvidence[0].scopeHeaderCount, 1);
      assert.equal(mainEvidence[0].bearerMainInjected, true);

      const socketUrl = `${REACT_FIXTURE_ORIGIN.replace(/^http/, 'ws')}/socket.io/`
        + `?EIO=4&transport=websocket&proprDesktopTransportScope=${activated.transportScope}`;
      assert.deepEqual(await intercepted(socketUrl, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Referer: RENDERER_URL,
        Authorization: 'Bearer foreign-controlled',
        Cookie: 'foreign=session',
      }, 'webSocket', otherRenderer.id), { cancel: true });
      const socket = await intercepted(socketUrl, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Cookie: 'renderer=must-not-cross',
        Authorization: 'Bearer renderer-controlled',
      }, 'webSocket');
      assert.equal(socket.cancel, undefined);
      assert.deepEqual(socket.requestHeaders, {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.deepEqual(await service.discardActivation(activated), { discarded: true });
      assert.equal(permissionCheck(null, 'loopback-network', DESKTOP_RENDERER_ORIGIN, {
        isMainFrame: true,
      }), false);
      for (const url of [...unrelatedTargets, `${REACT_FIXTURE_ORIGIN}/api/side-effect`]) {
        assert.deepEqual(await intercepted(url, 'GET', {
          Origin: DESKTOP_RENDERER_ORIGIN,
        }), { cancel: true }, `cached grant after discard: ${url}`);
      }
      assert.deepEqual(await intercepted(socketUrl, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
      }, 'webSocket'), { cancel: true });

      const revokedReady = await service.probe(profile);
      assert.equal(revokedReady.status, 'ready');
      if (revokedReady.status !== 'ready') return;
      const revoked = await service.activate(revokedReady.activationTicket);
      assert.deepEqual(await service.invalidate({
        profileId: profile.id,
        transportScope: revoked.transportScope,
        code: 'INSTANCE_TOKEN_REVOKED',
      }), { invalidated: true });
      assert.deepEqual(await intercepted(`${REACT_FIXTURE_ORIGIN}/api/side-effect`, 'GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
      }), { cancel: true });
      configured.dispose();
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
