import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexConfigPath } from '../../../config/configManager.js';
import type { ExtensionAutoApplySkip } from '../../../extensions/extensionRunResolution.js';

/** Built-in Codex providers: selecting one needs no definition in the operator config. */
const BUILT_IN_PROVIDERS = new Set(['openai', 'oss', 'ollama', 'lmstudio']);

/**
 * Whether an operator `config.toml` defines a custom model provider or a
 * profile. A Codex run with extensions passes `--ignore-user-config`, so such
 * a run would lose those settings. Only top-level keys and table headers are
 * read; values other than the selected provider name are never inspected.
 */
export function codexConfigDefinesProviderOrProfile(toml: string): boolean {
  let table = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header) {
      table = header[1].replace(/["']/g, '');
      if (/^(model_providers|profiles)(\.|$)/.test(table)) return true;
      continue;
    }
    const key = /^("?)([A-Za-z0-9_.-]+)\1\s*=\s*(.*)$/.exec(line);
    if (!key) continue;
    const name = table ? `${table}.${key[2]}` : key[2];
    if (/^(model_providers|profiles)(\.|$)/.test(name) || name === 'profile') return true;
    if (name === 'model_provider') {
      const value = /^["']([^"']*)["']/.exec(key[3])?.[1] ?? key[3].split('#')[0].trim();
      if (!BUILT_IN_PROVIDERS.has(value)) return true;
    }
  }
  return false;
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
