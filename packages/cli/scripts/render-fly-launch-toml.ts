/**
 * Writes the fly.toml files a Fly dashboard launch reads (#3827) from the
 * builders `propr deploy fly` uses: the root fly.toml (the released image,
 * pinned to the root package.json version) and deploy/fly/source/fly.toml
 * (builds from source). Run from the repository root, also after a version bump:
 *   npx tsx packages/cli/scripts/render-fly-launch-toml.ts
 * test/flyLaunchLayout.test.ts and `npm run release:verify` fail when the
 * committed files differ or the pinned image is not the package version.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flyLaunchConfigs, renderFlyLaunchToml } from '../src/commands/deploy/flyLaunchToml.ts';

const root = new URL('../../../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };
for (const config of flyLaunchConfigs(version)) {
  const target = fileURLToPath(new URL(config.path, root));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderFlyLaunchToml(config.path, config.build));
  console.log(`Wrote ${target}`);
}
