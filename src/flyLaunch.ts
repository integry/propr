/**
 * Entry of a Fly dashboard launch ("Launch an App → From GitHub", #3827),
 * started by scripts/fly-launch-entrypoint.sh as the committed fly.toml says.
 * `propr deploy fly` Machines run `node dist/src/allInOne.js` directly and
 * never reach this file, so they boot exactly as before.
 *
 * On every boot, before anything opens SQLite or Redis:
 *   1. Secrets `propr deploy fly` would generate are taken from the
 *      environment (Fly secrets win), else from the volume, else generated
 *      once and stored there with mode 0600 (flyLaunch/bootSecrets.ts).
 *   2. While the instance is unconfigured, the first-visit setup wizard runs
 *      on the API port, bound to a one-time setup code printed to the logs
 *      (flyLaunch/setupWizard.ts).
 *   3. What the wizard saved, and the env `propr deploy fly` derives from the
 *      app name, fill the variables the environment leaves unset.
 *   4. The control plane starts in this process (allInOne.ts); migrations run
 *      there, as on every other deploy.
 *
 * Only names are logged, never secret values. The setup code is the one
 * value printed on purpose: reading it from the logs proves Fly access.
 */
import { existsSync } from 'node:fs';
import { FLY_LAUNCH_ENV } from '@propr/shared';
import { ensureBootSecrets, flyLaunchEnablesMcp } from './flyLaunch/bootSecrets.js';
import { applyLaunchEnv, launchPublicUrl, readLaunchConfig, setupRequired } from './flyLaunch/launchConfig.js';
import { createLaunchStore, launchStoreDir } from './flyLaunch/launchStore.js';
import { createSetupAccess, formatSetupCode } from './flyLaunch/setupAccess.js';
import { runSetupWizard } from './flyLaunch/setupWizard.js';

const log = (message: string): void => console.log(message);

export async function prepareFlyLaunch(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const startEnv = { ...env };
    const store = createLaunchStore(launchStoreDir(env));
    // Decided before the MCP defaults are applied: an operator MCP setting turns them off.
    const mcp = flyLaunchEnablesMcp(startEnv);
    const secrets = ensureBootSecrets(env, store);
    log(`fly-launch: secrets from Fly: [${secrets.fromEnvironment.join(', ')}], from the volume: [${secrets.fromVolume.join(', ')}], generated now: [${secrets.generated.join(', ')}]`);

    let config = readLaunchConfig(store);
    if (setupRequired(config, startEnv)) {
        const publicUrl = launchPublicUrl(env);
        const access = createSetupAccess(store);
        const code = access.issueCode();
        if (code) {
            log('fly-launch: ======================================================');
            log(`fly-launch: ProPR setup code: ${formatSetupCode(code)}`);
            log(`fly-launch: open ${publicUrl}/setup and enter it to set up this instance.`);
            log('fly-launch: ======================================================');
        } else {
            log(`fly-launch: setup at ${publicUrl}/setup was already claimed by a browser; continue there`);
        }
        config = await runSetupWizard({
            store, access, publicUrl,
            controlPlaneApp: env.FLY_APP_NAME?.trim(),
            // A Fly secret PROPR_GH_RELAY_URL wins on boot, so the relay token must come from that relay.
            ...(env.PROPR_GH_RELAY_URL?.trim() ? { relayUrl: env.PROPR_GH_RELAY_URL.trim() } : {}),
            host: env.DASHBOARD_API_HOST?.trim() || '::',
            port: Number(env.DASHBOARD_API_PORT || 4000),
        });
    }
    const applied = applyLaunchEnv(env, store, config, { mcp, keyExists: existsSync });
    log(`fly-launch: setup values applied: [${applied.applied.join(', ')}]${applied.overridden.length ? `, overridden by Fly secrets: [${applied.overridden.join(', ')}]` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.env[FLY_LAUNCH_ENV] !== '1') {
        console.error(`fly-launch: ${FLY_LAUNCH_ENV}=1 is not set; this entry is for a Fly dashboard launch (fly.toml). Use node dist/src/allInOne.js otherwise.`);
        process.exit(1);
    }
    prepareFlyLaunch()
        .then(async () => (await import('./allInOne.js')).startAllInOne())
        .catch(error => {
            console.error(`fly-launch: startup failed: ${(error as Error)?.message ?? error}`);
            process.exit(1);
        });
}
