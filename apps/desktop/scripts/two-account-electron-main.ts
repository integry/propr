// Native synthetic regression host: production services and session boundary,
// isolated temporary storage, no real GitHub approval or OS keychain claim.
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopCredentialService } from '../src/credential-service';
import { ProfileStore } from '../src/profile-store';
import { registerIpcHandlers } from '../src/ipc';
import { configureDesktopSessionSecurity } from '../src/session-security';

async function main() {
app.setPath('userData', process.env.PROPR_ACCOUNT_SMOKE_DIRECTORY!);
protocol.registerSchemesAsPrivileged([{ scheme: 'propr-renderer', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
await app.whenReady();
const directory = process.env.PROPR_ACCOUNT_SMOKE_DIRECTORY!;
const rendererUrl = 'propr-renderer://app/index.html';
const desktopSession = session.fromPartition('account-smoke');
await desktopSession.protocol.handle('propr-renderer', async request => {
  const path = new URL(request.url).pathname;
  if (path !== '/index.html' && path !== '/renderer.js') return new Response(null, { status: 404 });
  return new Response(await readFile(join(directory, path.slice(1))), {
    headers: { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/html' },
  });
});
const encryption = { isEncryptionAvailable: () => true, backend: () => 'keychain',
  encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
const store = new ProfileStore(directory, encryption);
const credentials = new DesktopCredentialService({ profiles: store,
  fetch: desktopSession.fetch.bind(desktopSession), clientName: 'Synthetic native account regression',
  openPairingBrowser: async () => {}, confirmAccount: async () => true });
const window = new BrowserWindow({ show: false, webPreferences: {
  session: desktopSession, preload: join(directory, 'preload.cjs'),
  contextIsolation: true, nodeIntegration: false, sandbox: true,
} });
const security = configureDesktopSessionSecurity({ credentials, desktopSession,
  getMainRenderer: () => window.webContents,
  isTrustedRendererUrl: value => value === rendererUrl,
  contentSecurityPolicy: () => `default-src 'self'; script-src 'self'; connect-src 'self' ${process.env.PROPR_ACCOUNT_SMOKE_ENDPOINT} ${process.env.PROPR_ACCOUNT_SMOKE_ENDPOINT!.replace('http:', 'ws:')}; style-src 'self' 'unsafe-inline'`,
});
const ipc = registerIpcHandlers({ app, ipcMain, profiles: store, credentials,
  connectDiscovery: {} as never, lifecycle: {} as never, logger: { log() {} } as never,
  desktopSession, devServerUrl: undefined, packagedRendererUrl: rendererUrl, openExternal: async () => {},
});
// Accessible to Playwright's main-process evaluator only, never the renderer.
Object.assign(globalThis, { accountSmoke: {
  async snapshot() {
    const list = await store.list();
    return { ...list, credentialPresent: await Promise.all(list.profiles.map(async p => Boolean(await store.readCredential(p.id)))),
      pendingRevocations: (await store.pendingRevocations()).length };
  },
} });
app.on('before-quit', event => {
  event.preventDefault();
  void (async () => {
    ipc.close(); await ipc.awaitIdle(); await credentials.dispose(); await store.close();
    security.dispose(); ipc.dispose(); window.destroy(); app.exit(0);
  })();
});
await window.loadURL(rendererUrl);

}
void main().catch(error => { console.error(error); process.exit(1); });
