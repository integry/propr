import { app, BrowserWindow, protocol, session } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { DesktopCredentialService } from '../../../src/credential-service';
import { configureDesktopSessionSecurity } from '../../../src/session-security';

const attachment = 'https://github.com/user-attachments/assets/bfd3845c-0e36-42a1-a193-a58f2f368f1d';
const redirect = 'https://github-production-user-asset-6210df.s3.amazonaws.com/829273/659411478-bfd3845c-0e36-42a1-a193-a58f2f368f1d.png'
  + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20260926%2Fus-east-1%2Fs3%2Faws4_request'
  + '&X-Amz-Date=20260926T160427Z&X-Amz-Expires=300'
  + `&X-Amz-Signature=${'a'.repeat(64)}&X-Amz-SignedHeaders=host&response-content-type=image%2Fpng`;
const rendererUrl = 'propr-preview-proof://app/index.html';
const fixtureHosts = new Set([
  'github.com',
  'github-production-user-asset-6210df.s3.amazonaws.com',
]);
const fixtureConnectTargets = new Set([...fixtureHosts].map(host => `${host}:443`));
const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbch1AWHyQ8ooDnKF
hM5blcDBSdDKqZV2DtiBMSnUc9OhRANCAATySQD+yx5bCay6SrVS57PSrI2QpT4+
u+QDT4PtL12n7usvSZUexsYjIfEemPXn0KMpd0Kit3CaITmBCfSYiuHj
-----END PRIVATE KEY-----`;
const fixtureCertificate = `-----BEGIN CERTIFICATE-----
MIIB/DCCAaKgAwIBAgIUGj4iXthRG1C9tUh/FBNDjsEHMNYwCgYIKoZIzj0EAwIw
LDEqMCgGA1UEAwwhcHVibGlzaGVkLXByZXZpZXcuZml4dHVyZS5pbnZhbGlkMB4X
DTI2MDkyNjE2MzAzNVoXDTM2MDkyMzE2MzAzNVowLDEqMCgGA1UEAwwhcHVibGlz
aGVkLXByZXZpZXcuZml4dHVyZS5pbnZhbGlkMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE8kkA/sseWwmsukq1Uuez0qyNkKU+PrvkA0+D7S9dp+7rL0mVHsbGIyHx
Hpj159CjKXdCordwmiE5gQn0mIrh46OBoTCBnjAdBgNVHQ4EFgQU1+vUjwiG+2h3
mb0T14z+JO2uQIYwHwYDVR0jBBgwFoAU1+vUjwiG+2h3mb0T14z+JO2uQIYwDwYD
VR0TAQH/BAUwAwEB/zBLBgNVHREERDBCggpnaXRodWIuY29tgjRnaXRodWItcHJv
ZHVjdGlvbi11c2VyLWFzc2V0LTYyMTBkZi5zMy5hbWF6b25hd3MuY29tMAoGCCqG
SM49BAMCA0gAMEUCIBgwUdjtBSOZOmCBw7aLpdpbV1A4NL8M4+6lzf+HCgzwAiEA
kxXZbcciQEecy/o3IAnS6V+7AJ4LcIb8uA3hmrIadoI=
-----END CERTIFICATE-----`;

const listen = (server: Server): Promise<number> => new Promise((resolveListen, rejectListen) => {
  const failed = (error: Error) => rejectListen(error);
  server.once('error', failed);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', failed);
    const address = server.address();
    if (!address || typeof address === 'string') {
      rejectListen(new Error('Published-preview fixture did not receive a TCP port'));
      return;
    }
    resolveListen(address.port);
  });
});

const close = (server: Server): Promise<void> => new Promise(resolveClose => {
  server.close(() => resolveClose());
});

protocol.registerSchemesAsPrivileged([{ scheme: 'propr-preview-proof', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

app.whenReady().then(async () => {
  const imageArgument = process.argv.find(value => value.startsWith('--propr-published-preview-image='));
  const imagePath = imageArgument?.slice('--propr-published-preview-image='.length);
  if (!imagePath) throw new Error('Published-preview fixture --propr-published-preview-image is required');
  const image = await readFile(imagePath);
  const handled: Array<{ cookie: boolean; url: string }> = [];
  const tunnels: string[] = [];
  const sockets = new Set<Socket>();
  // A custom `https` protocol handler would bypass Electron's webRequest
  // callbacks. This TLS origin is reached only through the allowlisted local
  // CONNECT proxy below, preserving the canonical request URLs while forcing
  // both redirect hops through configureDesktopSessionSecurity.
  const originServer = createHttpsServer({ cert: fixtureCertificate, key: fixturePrivateKey }, (request, response) => {
    const host = request.headers.host ?? '';
    let url: string;
    try {
      url = new URL(request.url ?? '/', `https://${host}`).href;
    } catch {
      response.writeHead(400).end();
      return;
    }
    handled.push({ cookie: request.headers.cookie !== undefined, url });
    if (url === attachment) {
      response.writeHead(302, {
        location: redirect,
        'set-cookie': 'github-proof=must-not-stick; Secure; Path=/',
      }).end();
      return;
    }
    if (url === redirect) {
      response.writeHead(200, {
        'content-type': 'image/png',
        'set-cookie': 'cdn-proof=must-not-stick; Secure; Path=/',
      }).end(image);
      return;
    }
    response.writeHead(404).end();
  });
  const originPort = await listen(originServer);
  const proxyServer = createHttpServer((_request, response) => response.writeHead(405).end());
  proxyServer.on('connect', (request, client, head) => {
    const target = request.url ?? '';
    if (!fixtureConnectTargets.has(target)) {
      client.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      client.destroy();
      return;
    }
    tunnels.push(target);
    const upstream = connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.once('error', () => client.destroy());
  });
  const proxyPort = await listen(proxyServer);
  for (const server of [originServer, proxyServer]) {
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }

  try {
    const desktopSession = session.fromPartition(`published-preview-${process.pid}`);
    await desktopSession.setProxy({ mode: 'fixed_servers', proxyRules: `https=127.0.0.1:${proxyPort}` });
    desktopSession.setCertificateVerifyProc(({ hostname }, callback) => {
      callback(fixtureHosts.has(hostname) ? 0 : -2);
    });
    await desktopSession.cookies.set({ url: 'https://github.com', name: 'desktop-proof', value: 'must-not-cross', secure: true });
    await desktopSession.cookies.set({
      url: 'https://github-production-user-asset-6210df.s3.amazonaws.com',
      name: 'desktop-proof', value: 'must-not-cross', secure: true,
    });
    await desktopSession.protocol.handle('propr-preview-proof', () => new Response(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        body { align-items:center; background:#f1f5f9; display:flex; font:14px system-ui; justify-content:center; margin:0; min-height:100vh; }
        main { background:white; border:1px solid #cbd5e1; border-radius:12px; box-shadow:0 10px 28px #0f172a1f; padding:18px; width:360px; }
        h1 { color:#0f172a; font-size:16px; margin:0 0 12px; }
        img { background:#f8fafc; border-radius:8px; display:block; height:180px; object-fit:contain; width:100%; }
        #status { color:#166534; font-weight:600; margin:10px 0 0; }
        #fallback { color:#b91c1c; }
      </style></head><body><main><h1>Published preview</h1>
        <img id="preview" alt="Published GitHub preview" src="${attachment}"
          onload="document.getElementById('status').textContent='Preview loaded securely'"
          onerror="document.getElementById('fallback').hidden=false;this.hidden=true">
        <p id="status">Loading preview…</p><p id="fallback" hidden>Image unavailable</p>
      </main></body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }));
    const credentials = new DesktopCredentialService({
      profiles: { awaitIdle: async () => undefined } as never,
      fetch: async () => new Response(null, { status: 503 }),
      openPairingBrowser: async () => undefined,
      clientName: 'Published preview browser proof',
    });
    const boundary: Array<{
      authorization: boolean; cancelled: boolean; cookie: boolean;
      rendererOwned: boolean | undefined; resourceType: string | undefined; url: string;
    }> = [];
    const prepareRequest = credentials.prepareRequestAsync.bind(credentials);
    credentials.prepareRequestAsync = async (url, headers, details = {}) => {
      const decision = await prepareRequest(url, headers, details);
      if (url === attachment || url === redirect) {
        const outbound = Object.keys(decision.requestHeaders ?? {}).map(name => name.toLowerCase());
        boundary.push({
          authorization: outbound.includes('authorization'),
          cancelled: decision.cancel === true,
          cookie: outbound.includes('cookie'),
          rendererOwned: details.rendererOwned,
          resourceType: details.resourceType,
          url,
        });
      }
      return decision;
    };
    const window = new BrowserWindow({ show: false, width: 480, height: 360, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, session: desktopSession,
    } });
    const security = configureDesktopSessionSecurity({
      contentSecurityPolicy: () => "default-src 'self'; img-src https:; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      credentials,
      desktopSession,
      getMainRenderer: () => window.webContents,
      isTrustedRendererUrl: value => value === rendererUrl,
    });
    await window.loadURL(rendererUrl);
    const visible = await window.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('preview');
      const fallback = document.getElementById('fallback');
      const status = document.getElementById('status');
      const style = getComputedStyle(image);
      return { complete: image.complete, fallbackHidden: fallback.hidden,
        naturalHeight: image.naturalHeight, naturalWidth: image.naturalWidth,
        status: status.textContent, visible: style.display !== 'none' && image.getBoundingClientRect().width > 0 };
    })()`);
    const previewPath = process.env.PROPR_DESKTOP_PUBLISHED_PREVIEW_SCREENSHOT;
    if (previewPath) await writeFile(resolve(previewPath), (await window.capturePage()).toPNG());
    const cookies = await desktopSession.cookies.get({});
    process.stdout.write(`${JSON.stringify({
      boundary,
      handled,
      responseCookiesPersisted: cookies.some(cookie => cookie.name === 'github-proof' || cookie.name === 'cdn-proof'),
      tunnels,
      visible,
    })}\n`);
    security.dispose();
    await credentials.dispose();
    window.destroy();
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(proxyServer), close(originServer)]);
  }
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
