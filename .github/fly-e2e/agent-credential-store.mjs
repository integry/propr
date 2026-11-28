// Prepended to the scripts the Fly smoke runs over `fly ssh console` in the app container: the
// agent save (configPath) and the credential install (install-agent-credential.mjs). Both locate
// the agent's credential store with agentCredentialStore, so the store is installed where the
// saved configPath resolves. Dynamic imports only, so it can precede any script.
//
// An SSH session does not inherit the app container's configured environment, so a value is read
// from the app process's environment first (PID 1 in the container, or PROPR_E2E_APP_ENVIRON_FILE),
// then from the session's own.

async function appEnvironment() {
  const { readFileSync } = await import('node:fs');
  const source = process.env.PROPR_E2E_APP_ENVIRON_FILE || '/proc/1/environ';
  const app = new Map();
  let entries = [];
  try {
    entries = readFileSync(source, 'utf8').split('\0');
  } catch {
    // Unreadable: the session's environment alone.
  }
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator > 0) app.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const get = (name) => app.get(name) || process.env[name] || undefined;
  return { get, source };
}

// Agents with no ProPR-managed login layout (outside getManagedAgentConfigPath): their store gets
// an absolute path in the same managed credential directory, which the app uses unchanged.
const UNMANAGED_CREDENTIAL_STORES = { vibe: '.vibe' };

/**
 * The agent configuration `type` (id and alias `type`): its configPath to save, and the directory
 * on the volume that configPath resolves to. The managed credential directory resolves as the app
 * resolves it on Fly: PROPR_MANAGED_CREDENTIALS_DIR, which the deploy sets to
 * $DATA_DIR/agent-credentials (/usr/src/app/data/agent-credentials), else that default.
 */
async function agentCredentialStore(type) {
  const { isAbsolute, join } = await import('node:path');
  const { getManagedAgentConfigPath, getManagedAgentConfigRelativePath, isAgentLoginSupported } = await import('@propr/shared');
  const env = await appEnvironment();
  const configured = env.get('PROPR_MANAGED_CREDENTIALS_DIR');
  const dataDir = env.get('DATA_DIR');
  const root = configured || (dataDir && join(dataDir, 'agent-credentials'));
  if (!root) {
    throw new Error(`PROPR_MANAGED_CREDENTIALS_DIR and DATA_DIR are both unset in the app environment (${env.source}) and this session: cannot locate the managed credential directory`);
  }
  const rootName = configured ? 'PROPR_MANAGED_CREDENTIALS_DIR' : 'DATA_DIR';
  if (!isAbsolute(root)) throw new Error(`${rootName} must be an absolute path, not "${root}"`);
  if (isAgentLoginSupported(type)) {
    const configPath = getManagedAgentConfigPath(type, type);
    const relative = getManagedAgentConfigRelativePath(configPath);
    if (!relative) throw new Error(`${configPath} is not a managed credential path for ${type}`);
    return { configPath, dir: join(root, relative), env };
  }
  const store = UNMANAGED_CREDENTIAL_STORES[type];
  if (!store) throw new Error(`No credential store layout for agent type "${type}"`);
  const dir = join(root, type, store);
  return { configPath: dir, dir, env };
}
