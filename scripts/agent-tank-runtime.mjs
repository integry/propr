/** Prepare private CLI state without giving providers write access to host credentials. */
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareAgentTankRuntime(configFile) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const root = mkdtempSync(join(dirname(configFile), 'runtime-'));
  chmodSync(root, 0o700);
  try {
    config.agents = config.agents.map((entry, index) => {
      const filename = { claude: '.credentials.json', codex: 'auth.json' }[entry.provider];
      // AGY already supports the read-only mount and retains its existing path.
      if (!filename) return entry;
      const home = join(root, String(index));
      mkdirSync(home, { mode: 0o700 });
      const source = join(entry.configPath, filename);
      if (existsSync(source)) {
        copyFileSync(source, join(home, filename));
        chmodSync(join(home, filename), 0o600);
      }
      // Do not copy host sessions, SQLite databases, MCP servers, or plugins.
      // Codex creates its own SQLite state here; Claude can keep refreshed
      // credentials here. The --rm container owns and discards every write.
      if (entry.provider === 'claude') config.claudeApi = true;
      return { ...entry, configPath: home };
    });
    writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    chmodSync(configFile, 0o600);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    prepareAgentTankRuntime(process.argv[2]);
  } catch {
    // Never print credential contents or provider configuration on failure.
    console.error('Unable to prepare isolated Agent Tank runtime');
    process.exitCode = 1;
  }
}
