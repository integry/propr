import { DesktopCredentialService } from './credential-service';
import { ProfileStore, type EncryptionProvider } from './profile-store';

const [directory, mode] = process.argv.slice(2) as [string, 'during-revoke' | 'after-remote-success'];
const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};
const store = new ProfileStore(directory, encryption);
const profiles = mode === 'after-remote-success'
  ? new Proxy(store, {
      get(target, property) {
        if (property === 'completePendingRevocation') return async () => {
          process.kill(process.pid, 'SIGKILL');
          return false;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })
  : store;
const service = new DesktopCredentialService({
  profiles,
  clientName: 'Crash fixture',
  openPairingBrowser: async () => undefined,
  fetch: async (input, init) => {
    if (input.toString().endsWith('/api/desktop/discovery')) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        product: 'ProPR',
        version: '0.8.15',
        apiCompatibility: '2026-08-01',
        uiCompatibility: '2026-08-01',
        canonicalEndpoint: null,
        publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
        desktopAuthentication: {
          protocolVersion: 2,
          browserPairing: true,
          instanceBearerTokens: true,
          socketIoBearerAuthentication: true,
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const authorization = new Headers(init?.headers).get('Authorization');
    if (authorization !== `Bearer propr_it_${'A'.repeat(43)}`) {
      throw new Error('Pending revocation used the wrong credential');
    }
    if (mode === 'during-revoke') process.kill(process.pid, 'SIGKILL');
    return new Response(null, { status: 204 });
  },
});
await service.initialize();
