import path from 'node:path';
import { z } from 'zod';
import { fleetResetBindingSchema, canonicalFleetJson } from '@propr/shared';
import { FleetFiles } from './files.js';
import { NativeResetRuntime } from './nativeReset.js';
import { ResetGenerationFence, resetUnavailable } from './resetFence.js';
import { HttpResetBoundary, ResetQueueAdapter, ResetAuthorityAdapter } from './resetAdapters.js';

const provisioningSchema = z.strictObject({
  binding: fleetResetBindingSchema,
  tenantRoot: z.string().min(1),
  services: z.strictObject({ queue: z.string().url(), sessions: z.string().url(), tunnel_bootstrap: z.string().url() }),
});
export interface ConfiguredResetResources {
  queues: ConstructorParameters<typeof ResetQueueAdapter>[2];
  connections: ConstructorParameters<typeof ResetQueueAdapter>[3];
  sessions: ConstructorParameters<typeof ResetAuthorityAdapter>[2];
  close(): Promise<void>;
}
/** Fleet provisions native.json alongside authority.json. Absence preserves
 * self-hosted behavior. Root ownership and external service authority are not
 * accepted from the reset request. No provisioning files are created here. */
export async function configuredNativeReset(root: string, resources?: ConfiguredResetResources): Promise<NativeResetRuntime | undefined> {
  const files = new FleetFiles(root);
  try { await files.initialize(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let bytes: string;
  try { bytes = await files.read('native.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const provision = provisioningSchema.parse(JSON.parse(bytes));
  const authority = JSON.parse(await files.read('authority.json'));
  if (canonicalFleetJson(authority.binding) !== canonicalFleetJson(provision.binding) ||
      path.resolve(process.env.PROPR_FLEET_RESET_RUNTIME_ROOT ?? '') !== path.resolve(root)) resetUnavailable();
  const tenant = path.resolve(provision.tenantRoot);
  // Native managed layouts are deliberately explicit. An existing self-hosted
  // installation is never silently reclassified as owned/destructible state.
  const paths: Record<string, string> = {
    DB_FILENAME: path.join(tenant, 'database', 'propr.sqlite'),
    GIT_CLONES_BASE_PATH: path.join(tenant, 'repositories_worktrees_caches', 'clones'),
    GIT_WORKTREES_BASE_PATH: path.join(tenant, 'repositories_worktrees_caches', 'worktrees'),
    HOME: path.join(tenant, 'provider_sessions'),
  };
  for (const [key, expected] of Object.entries(paths)) if (!process.env[key] || path.resolve(process.env[key]!) !== expected) resetUnavailable();
  const key = () => {
    const value = process.env.PROPR_FLEET_RESET_SERVICE_SECRET;
    if (!value || value.length < 32) return resetUnavailable(); return value;
  };
  key();
  const fence = new ResetGenerationFence(root);
  const external = (name: keyof typeof provision.services) => new HttpResetBoundary(provision.services[name], key, name);
  try {
    let closed = !resources && fence.effect('close-resources')?.result === 'true';
    return new NativeResetRuntime({ tenantRoot: tenant, controlRoot: root, binding: provision.binding,
      closeAdapters: () => fence.close(),
      adapters: [new ResetQueueAdapter(fence, [], resources?.queues ?? [], resources?.connections ?? [], external('queue')),
        new ResetAuthorityAdapter('sessions', fence, resources?.sessions ?? [], external('sessions')),
        new ResetAuthorityAdapter('tunnel_bootstrap', fence, [], external('tunnel_bootstrap'))],
      resources: { close: async () => { if (!resources) resetUnavailable(); await resources!.close(); closed = true; }, observeClosed: async () => closed && fence.idle() },
    });
  } catch (error) { fence.close(); throw error; }
}
