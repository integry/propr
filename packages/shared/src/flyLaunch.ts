/**
 * What `propr deploy fly` and a Fly dashboard launch ("Launch an App → From
 * GitHub", #3827) share, so the two cannot drift:
 *
 * - the public URL and ProPR MCP instance id derived from the Fly app name;
 * - the secrets the CLI generates on a first deploy, which a dashboard launch
 *   generates on first boot instead (src/flyLaunch/bootSecrets.ts);
 * - the settings that mean the operator manages ProPR MCP themselves.
 */

/** The Machine's public origin through the Fly proxy. */
export function flyPublicUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

/** MCP_INSTANCE_ID must be 8–128 characters; Fly app names can be as short as 2. Stable across redeploys. */
export function flyMcpInstanceId(app: string): string {
  return `propr-fly-${app}`;
}

export interface FlyGeneratedSecretSpec {
  name: string;
  bytes: number;
  encoding: 'hex' | 'base64';
  /** Only generated when the deploy turns ProPR MCP on. */
  mcpOnly?: boolean;
}

/**
 * Secrets `propr deploy fly` generates when the app does not have them, in the
 * order they are generated:
 *
 * - SESSION_SECRET signs browser sessions.
 * - SYSTEM_TASK_SECRET signs system tasks (reverts) and the worker's requests
 *   for run-scoped ProPR MCP grants. Without it every automation, acting step
 *   and agent run that needs ProPR MCP is refused on the worker.
 * - MCP_ENCRYPTION_KEY seals the MCP server's records, only when MCP is on.
 */
export const FLY_GENERATED_SECRETS: readonly FlyGeneratedSecretSpec[] = [
  { name: 'SESSION_SECRET', bytes: 32, encoding: 'hex' },
  { name: 'SYSTEM_TASK_SECRET', bytes: 32, encoding: 'hex' },
  { name: 'MCP_ENCRYPTION_KEY', bytes: 32, encoding: 'base64', mcpOnly: true },
];

/** MCP settings that mean the operator manages ProPR MCP; the Fly defaults then set none of theirs. */
export const FLY_USER_MANAGED_MCP_KEYS: readonly string[] = ['MCP_ENABLED', 'MCP_PUBLIC_ORIGIN', 'MCP_INSTANCE_ID'];

/**
 * Plain env a Fly dashboard launch's fly.toml sets: the Machine runs the
 * launch entry (src/flyLaunch.ts), which generates missing secrets on the
 * volume and serves the first-visit setup wizard until it is done.
 * `propr deploy fly` never sets it, so its Machines boot exactly as before.
 */
export const FLY_LAUNCH_ENV = 'PROPR_FLY_LAUNCH';

/**
 * Set by the dashboard launch layout, where ProPR and Redis run in ONE
 * container: the process exiting stops the Machine, so an idle stop needs no
 * Machines API token (see src/flyMachineStop.ts).
 */
export const FLY_EXIT_STOPS_MACHINE_ENV = 'PROPR_FLY_EXIT_STOPS_MACHINE';
