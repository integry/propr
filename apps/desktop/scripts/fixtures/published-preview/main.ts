import { app, BrowserWindow, protocol, session } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DesktopCredentialService } from '../../../src/credential-service';
import { configureDesktopSessionSecurity } from '../../../src/session-security';

const attachment = 'https://github.com/user-attachments/assets/bfd3845c-0e36-42a1-a193-a58f2f368f1d';
const redirect = 'https://github-production-user-asset-6210df.s3.amazonaws.com/829273/659411478-bfd3845c-0e36-42a1-a193-a58f2f368f1d.png'
  + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20260926%2Fus-east-1%2Fs3%2Faws4_request'
  + '&X-Amz-Date=20260926T160427Z&X-Amz-Expires=300'
  + `&X-Amz-Signature=${'a'.repeat(64)}&X-Amz-SignedHeaders=host&response-content-type=image%2Fpng`;
const rendererUrl = 'propr-preview-proof://app/index.html';

protocol.registerSchemesAsPrivileged([{ scheme: 'propr-preview-proof', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

app.whenReady().then(async () => {
  const imagePath = process.argv[2];
  if (!imagePath) throw new Error('Published-preview fixture image path is required');
  const image = await readFile(imagePath);
  const desktopSession = session.fromPartition(`published-preview-${process.pid}`);
  const handled: Array<{ cookie: boolean; url: string }> = [];
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
  await desktopSession.protocol.handle('https', request => {
    handled.push({ cookie: request.headers.has('cookie'), url: request.url });
    if (request.url === attachment) return new Response(null, {
      status: 302,
      headers: { location: redirect, 'set-cookie': 'github-proof=must-not-stick; Secure; Path=/' },
    });
    if (request.url === redirect) return new Response(image, {
      headers: { 'content-type': 'image/png', 'set-cookie': 'cdn-proof=must-not-stick; Secure; Path=/' },
    });
    return new Response(null, { status: 404 });
  });
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
    visible,
  })}\n`);
  security.dispose();
  await credentials.dispose();
  window.destroy();
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
