import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configuredNativeReset } from '../core/src/fleet/configuredReset.js';
import { listenFleetResetRecovery } from './fleetDataListener.js';

/** Dedicated recovery startup deliberately imports no application server or DB
 * singleton. It never launches future-on-boot work or replays reset effects. */
export async function startFleetResetRecovery() {
  const root = process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  if (!root) throw new Error('fleet_reset_unavailable');
  const native = await configuredNativeReset(root);
  if (!native) throw new Error('fleet_reset_unavailable');
  try {
    const listener = await listenFleetResetRecovery(root, native);
    return { address: listener.address, shutdown: async () => {
      try { await listener.shutdown(); } finally { native.close(); }
    } };
  } catch (error) { native.close(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const listener = await startFleetResetRecovery();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void listener.shutdown(); });
}
