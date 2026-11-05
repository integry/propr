/** Prepare private CLI state without giving providers write access to host credentials. */
import { copyFileSync, chmodSync, chownSync, readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareAgentTankRuntime(configFile) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const root = mkdtempSync(join(dirname(configFile), 'runtime-'));
  chmodSync(root, 0o700);
  try {
    config.agents = config.agents.map((entry, index) => {
      const filenames = {
        claude: ['.credentials.json'],
        codex: ['auth.json'],
        agy: ['antigravity-cli/antigravity-oauth-token', 'antigravity-cli/cache/onboarding.json'],
      }[entry.provider];
      if (!filenames) return entry;
      const home = join(root, String(index));
      mkdirSync(home, { mode: 0o700 });
      for (const filename of filenames) {
        const source = join(entry.configPath, filename);
        if (existsSync(source)) {
          mkdirSync(dirname(join(home, filename)), { recursive: true, mode: 0o700 });
          copyFileSync(source, join(home, filename));
          chmodSync(join(home, filename), 0o600);
        }
      }
      // Do not copy host sessions, SQLite databases, MCP servers, or plugins.
      // Codex creates its own SQLite state here; Claude can keep refreshed
      // credentials here. The --rm container owns and discards every write.
      if (entry.provider === 'claude') {
        config.claudeApi = true;
        const profilePath = join(entry.configPath, '.claude.json');
        if (existsSync(profilePath)) {
          const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
          const allowed = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'oauthAccount', 'userID'];
          const privateProfile = Object.fromEntries(allowed.filter(key => key in profile).map(key => [key, profile[key]]));
          writeFileSync(join(home, '.claude.json'), JSON.stringify(privateProfile), { mode: 0o600 });
        }
      }
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
    const configFile = process.argv[2];
    const root = prepareAgentTankRuntime(configFile);
    if (process.argv[3] === '--run') {
      // Root only copies the allowlisted files from read-only host mounts. All
      // provider processes run unprivileged against disposable private copies.
      const options = { stdio: 'inherit', env: { ...process.env, HOME: '/home/node', USER: 'node', LOGNAME: 'node' } };
      if (process.getuid() === 0) {
        const own = path => {
          chownSync(path, 1000, 1000);
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) own(child);
            else chownSync(child, 1000, 1000);
          }
        };
        own(root);
        chownSync(configFile, 1000, 1000);
        chownSync(dirname(configFile), 1000, 1000);

      }
      const command = process.getuid() === 0 ? ['gosu', 'node', 'agent-tank'] : ['agent-tank'];
      const result = spawnSync(command[0], [...command.slice(1), '--once', '--json', '--config', configFile], options);
      process.exitCode = result.status ?? 1;
    }
  } catch {
    // Never print credential contents or provider configuration on failure.
    console.error('Unable to prepare isolated Agent Tank runtime');
    process.exitCode = 1;
  }
}
