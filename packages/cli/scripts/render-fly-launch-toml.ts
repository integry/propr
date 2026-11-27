/**
 * Writes the root fly.toml a Fly dashboard launch reads (#3827) from the
 * builders `propr deploy fly` uses. Run from the repository root:
 *   npx tsx packages/cli/scripts/render-fly-launch-toml.ts
 * test/flyLaunchLayout.test.ts fails when the committed file differs.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFlyLaunchToml } from '../src/commands/deploy/flyLaunchToml.ts';

const target = fileURLToPath(new URL('../../../fly.toml', import.meta.url));
writeFileSync(target, renderFlyLaunchToml());
console.log(`Wrote ${target}`);
