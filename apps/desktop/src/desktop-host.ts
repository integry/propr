import { ConfigManager } from '@propr/cli/dist/config/index.js';
import { loginWithGithubCli } from '@propr/cli/dist/auth/githubLogin.js';
import { configureStackTemplatePath } from '@propr/cli/dist/commands/initStack.js';
import { createDefaultActions } from '@propr/cli/dist/commands/setup/hostActions.js';
import { configureOrchestratorAssetPath, getHostConfig } from '@propr/cli/dist/orchestrator/index.js';
import { localhostServiceUrl } from '@propr/cli/dist/utils/dockerPort.js';
import { join, resolve } from 'node:path';
import type { SetupActions } from '@propr/local-setup';
import type { LocalLifecycleHost } from './lifecycle';
import { bindRootOperations, RootDirectoryAuthority } from './setup-capabilities';

export interface DesktopLocalHost {
  actions: SetupActions;
  config: ConfigManager;
  lifecycle: LocalLifecycleHost;
  resolveApiBaseUrl(rootDir: string): Promise<string>;
}

/** Bind the portable setup engine to the same launcher used by the CLI. */
export async function createDesktopLocalHost(resourcesPath?: string, defaultRootDir?: string): Promise<DesktopLocalHost> {
  if (resourcesPath) {
    configureOrchestratorAssetPath(join(resourcesPath, 'orchestrator', 'orchestrator.mjs'));
    configureStackTemplatePath(join(resourcesPath, 'assets', 'env.example.txt'));
  }
  const config = new ConfigManager();
  await config.init();
  const defaultActions = createDefaultActions(config);
  const actions: SetupActions = {
    ...defaultActions,
    async loginWithGithub({ onLog, signal } = {}) {
      // A packaged GUI has no controlling terminal. Reuse an existing gh
      // session, but leave an actionable recovery step instead of launching an
      // invisible interactive process when the user is not signed in.
      const result = await loginWithGithubCli(config, { interactive: false, onLog, signal });
      if (!result.ok) onLog?.(result.message);
      return result.ok;
    },
  };

  const root = (): string => {
    const value = config.getStackRoot();
    if (!value) throw new Error('No local ProPR stack has been configured');
    if (!defaultRootDir || resolve(value) !== resolve(defaultRootDir)) {
      throw new Error('A custom setup directory must be selected again in the setup wizard before local runtime operations.');
    }
    return resolve(defaultRootDir);
  };

  const withFixedRoot = async <T>(operation: (authority: RootDirectoryAuthority, displayRoot: string) => Promise<T>): Promise<T> => {
    const displayRoot = root();
    const authority = RootDirectoryAuthority.open(displayRoot, true);
    try { return await operation(authority, displayRoot); } finally { authority.close(); }
  };

  return {
    actions,
    config,
    async resolveApiBaseUrl(rootDir) {
      const { cfg } = await getHostConfig({ configManager: config, root: rootDir });
      return localhostServiceUrl(cfg.apiPort);
    },
    lifecycle: {
      async running() {
        if (!config.getStackRoot()) return false;
        return withFixedRoot((authority, displayRoot) => bindRootOperations(actions, displayRoot, authority).isStackRunning(displayRoot));
      },
      async start() {
        await withFixedRoot((authority, displayRoot) => bindRootOperations(actions, displayRoot, authority).startStack({ rootDir: displayRoot }));
      },
      async stop() {
        await withFixedRoot(async (authority) => {
          authority.validate();
          const { orch, cfg } = await getHostConfig({ configManager: config, root: authority.operationPath() });
          authority.validate();
          const { failed } = orch.stopStack(cfg, { remove: false, removeNetwork: false });
          authority.validate();
          if (failed.length) throw new Error(`Could not stop ${failed.join(', ')}`);
        });
      },
    },
  };
}
