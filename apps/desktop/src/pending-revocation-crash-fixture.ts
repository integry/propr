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
  openExternal: async () => undefined,
  fetch: async (_input, init) => {
    const authorization = new Headers(init?.headers).get('Authorization');
    if (authorization !== `Bearer propr_it_${'A'.repeat(43)}`) {
      throw new Error('Pending revocation used the wrong credential');
    }
    if (mode === 'during-revoke') process.kill(process.pid, 'SIGKILL');
    return new Response(null, { status: 204 });
  },
});
await service.initialize();
