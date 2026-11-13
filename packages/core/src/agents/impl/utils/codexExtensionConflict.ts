import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { resolveCodexConfigPath } from '../../../config/configManager.js';
import type { ExtensionAutoApplySkip } from '../../../extensions/extensionRunResolution.js';

/** Built-in Codex providers: selecting one needs no definition in the operator config. */
const BUILT_IN_PROVIDERS = new Set(['openai', 'oss', 'ollama', 'lmstudio']);

/**
 * Whether an operator `config.toml` defines a custom model provider or a
 * profile. A Codex run with extensions passes `--ignore-user-config`, so such
 * a run would lose those settings. The file is parsed as TOML, so bare, basic
 * and literal keys, dotted keys and inline tables are all read the way Codex
 * reads them; only the top-level `model_provider`, `model_providers`,
 * `profile` and `profiles` fields are inspected. A file that does not parse is
 * treated as defining one: today Codex reads it, and ignoring it could change
 * what the run does.
 */
export function codexConfigDefinesProviderOrProfile(toml: string): boolean {
  let config: Record<string, unknown>;
  try { config = parseToml(toml); } catch { return true; }
  if (Object.hasOwn(config, 'model_providers') || Object.hasOwn(config, 'profiles') || Object.hasOwn(config, 'profile')) return true;
  if (!Object.hasOwn(config, 'model_provider')) return false;
  const provider = config.model_provider;
  return typeof provider !== 'string' || !BUILT_IN_PROVIDERS.has(provider);
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch { return false; }
}

/**
 * Why a Codex task launch cannot use auto-applied extension library items
 * without breaking a run that works today, or null. Checked by the worker
 * before the container exists; the entrypoint refusal stays for explicit items.
 */
export async function codexAutoApplyConflict(configPath: string, worktreePath: string): Promise<ExtensionAutoApplySkip | null> {
  // The entrypoint refuses `.codex/config.toml` in the workspace or its container ancestry;
  // the ancestry above the workspace mount is the provider home, which is excluded there.
  if (worktreePath && await exists(path.join(worktreePath, '.codex', 'config.toml'))) return 'codex_workspace_config';
  let toml: string;
  try { toml = await fs.readFile(path.join(resolveCodexConfigPath(configPath), 'config.toml'), 'utf8'); }
  catch { return null; }
  return codexConfigDefinesProviderOrProfile(toml) ? 'codex_operator_config' : null;
}
