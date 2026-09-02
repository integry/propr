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
      activeBindingPresent: true,
      permission: 'loopback-network',
      rendererDocumentUrl: RENDERER_URL,
      rendererDocumentTrusted: true,
      rendererMainFrame: true,
      rendererMatchesMainWindow: true,
      requestingOrigin: DESKTOP_RENDERER_ORIGIN,
    };
    assert.equal(desktopNetworkPermissionAllowed(accepted), true);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, activeBindingPresent: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'notifications' }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, rendererMainFrame: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, rendererMatchesMainWindow: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, rendererDocumentTrusted: false }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, requestingOrigin: 'https://attacker.example' }), false);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'local-network' }), true);
    assert.equal(desktopNetworkPermissionAllowed({ ...accepted, permission: 'local-network-access' }), true);
  });

  it('carries the fixed-alias React preflight and one GET through the same production interceptor as smoke', async () => {
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
      const activated = await service.activate(probed.activationTicket);

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
        },
        callback: (decision: Record<string, unknown>) => void,
      ) => void;
      let permissionCheck: PermissionCheck = () => { throw new Error('Permission check was not installed'); };
      let permissionRequest: PermissionRequest = () => { throw new Error('Permission request was not installed'); };
      let beforeSendHeaders: BeforeSendHeaders = () => { throw new Error('Request interceptor was not installed'); };
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
      const mainRenderer = { getURL: () => RENDERER_URL } as unknown as WebContents;
      const configured = configureDesktopSessionSecurity({
        contentSecurityPolicy: () => "default-src 'self'",
        credentials: service,
        desktopSession,
        getMainRenderer: () => mainRenderer,
        isTrustedRendererUrl: value => value === RENDERER_URL,
      });

      assert.equal(permissionCheck(
        mainRenderer,
        'loopback-network',
        DESKTOP_RENDERER_ORIGIN,
        { requestingUrl: RENDERER_URL, isMainFrame: true },
      ), true);
      let requestedPermission = false;
      permissionRequest(
        mainRenderer,
        'loopback-network',
        (allowed: boolean) => { requestedPermission = allowed; },
        { requestingUrl: RENDERER_URL, isMainFrame: true },
      );
      assert.equal(requestedPermission, true);

      const currentUserUrl = `${REACT_FIXTURE_ORIGIN}/api/auth/user?proprDesktopScopeGeneration=1`;
      const intercepted = async (method: 'OPTIONS' | 'GET', headers: Record<string, string>) => {
        return await new Promise<Record<string, unknown>>(resolve => beforeSendHeaders({
          url: currentUserUrl,
          method,
          resourceType: 'xhr',
          requestHeaders: headers,
        }, resolve));
      };
      const preflight = await intercepted('OPTIONS', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': DESKTOP_TRANSPORT_SCOPE_HEADER,
      });
      assert.equal(preflight.cancel, undefined);
      assert.equal(new Headers(preflight.requestHeaders as HeadersInit).has('Authorization'), false);

      const get = await intercepted('GET', {
        Origin: DESKTOP_RENDERER_ORIGIN,
        Cookie: 'renderer=must-not-cross',
        [DESKTOP_TRANSPORT_SCOPE_HEADER]: activated.transportScope,
      });
      const outbound = new Headers(get.requestHeaders as HeadersInit);
      assert.equal(get.cancel, undefined);
      assert.equal(outbound.get('Authorization'), `Bearer ${TOKEN}`);
      assert.equal(outbound.has('Cookie'), false);
      assert.equal(outbound.has(DESKTOP_TRANSPORT_SCOPE_HEADER), false);
      assert.equal(mainEvidence.length, 1);
      assert.equal(mainEvidence[0].accepted, true);
      assert.equal(mainEvidence[0].rendererScopeGeneration, 1);
      assert.equal(mainEvidence[0].scopeHeaderCount, 1);
      assert.equal(mainEvidence[0].bearerMainInjected, true);
      configured.dispose();
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
