import { DEFAULT_PROPR_ROUTING_URL, resolveGithubEventIntakeMode } from '@propr/shared';
import { parseConnectAccountStatus } from '../../intake/routingConnectAccountStatus.js';
import { ManagedPreviewStorageClientV1 } from './v1.js';

/** Reuse the daemon's connection-scoped account_status; Redis expiry also fails closed. */
export function createManagedPreviewStorageClient(
  readRoutingSnapshot: () => Promise<string | null>,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): ManagedPreviewStorageClientV1 {
  return new ManagedPreviewStorageClientV1({
    routingUrl: (environment.PROPR_ROUTING_URL ?? DEFAULT_PROPR_ROUTING_URL).trim(),
    trustedConnectOrigin: (environment.PROPR_CONNECT_URL ?? 'https://connect.propr.dev').trim(),
    relayToken: environment.PROPR_GH_RELAY_TOKEN?.trim() ?? '',
    fetchImpl,
    getConnectContext: async () => {
      const unavailable = { connected: false };
      if (!environment.PROPR_GH_RELAY_TOKEN?.trim()
        || resolveGithubEventIntakeMode({ eventIntakeMode: environment.GITHUB_EVENT_INTAKE_MODE }).mode !== 'routing_websocket') return unavailable;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          readRoutingSnapshot(),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_500); }),
        ]);
        if (!raw) return unavailable;
        const state = JSON.parse(raw);
        if (state?.connected !== true || !state.connectAccount || typeof state.connectAccount !== 'object') return unavailable;
        const account = parseConnectAccountStatus({ ...state.connectAccount, type: 'account_status' });
        if (!account || account.installationId !== Number(environment.GH_INSTALLATION_ID)) return unavailable;
        return { connected: true, connectAccount: account };
      } catch { return unavailable; }
      finally { clearTimeout(timer); }
    },
  });
}

