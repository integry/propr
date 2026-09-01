import {
  runSetup as runLocalSetup,
  getLocalSetupCapability,
  retrySetup as retryLocalSetup,
  resolveSetupRoot,
  type RunSetupOptions as LocalRunSetupOptions,
  type SetupActions,
  type SetupRunResult,
} from "@propr/local-setup";
import type { ConfigManager } from "../../config/index.js";
import { createDefaultActions } from "./hostActions.js";

export * from "@propr/local-setup";
export { createDefaultActions } from "./hostActions.js";

/** CLI-compatible options layered over the host-neutral package contract. */
export interface RunSetupOptions extends Omit<LocalRunSetupOptions, "actions" | "root"> {
  configManager?: ConfigManager;
  root?: string;
  actions?: Partial<SetupActions>;
}

export async function runSetup(options: RunSetupOptions = {}): Promise<SetupRunResult> {
  const { configManager, actions: overrides, root, ...portable } = options;
  const capability = getLocalSetupCapability(portable.platform);
  if (!capability.supported) throw new Error(capability.reason);
  const actions = { ...createDefaultActions(configManager), ...overrides } as SetupActions;
  return runLocalSetup({
    ...portable,
    root: resolveSetupRoot(configManager, root),
    actions,
  });
}

export function retrySetup(previous: SetupRunResult, options: Omit<RunSetupOptions, "root"> = {}): Promise<SetupRunResult> {
  const { configManager, actions: overrides, ...portable } = options;
  const capability = getLocalSetupCapability(portable.platform);
  if (!capability.supported) return Promise.reject(new Error(capability.reason));
  const actions = { ...createDefaultActions(configManager), ...overrides } as SetupActions;
  return retryLocalSetup(previous, { ...portable, actions });
}
