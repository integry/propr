#!/usr/bin/env node
// Propr launcher: replaces docker-compose for production deployments.
//
// Runs INSIDE the propr/launcher container — uses the mounted docker socket to
// orchestrate sibling containers on the host's docker daemon. All the real
// logic lives in orchestrator.mjs (shared with the `propr` CLI); this file is a
// thin wrapper that wires it up for the containerized, log-streaming use case.

import {
    resolveConfig, validateEnv, ensureNetwork, pullImages,
    startStack, stopStack, getStackStatus, getServiceLogs,
} from './orchestrator.mjs';

const cfg = resolveConfig(process.env);

function shutdown(code = 0) {
    console.log('\nshutting down…');
    stopStack(cfg, { remove: true, onLog: (l) => console.log(l) });
    process.exit(code);
}

async function main() {
    console.log(`propr launcher ${cfg.manifest.version}`);
    console.log(`  stack: ${cfg.stack}`);
    console.log(`  network: ${cfg.network}`);
    console.log(`  env file: ${cfg.envFileHost}`);

    const validation = validateEnv(cfg);
    for (const w of validation.warnings) console.warn(`WARNING: ${w}`);
    if (!validation.ok) {
        for (const e of validation.errors) console.error(`ERROR: ${e}`);
        console.error('\nExample: -e PROPR_ENV_FILE=$PWD/.env -e PROPR_DATA_DIR=$PWD/data ...');
        process.exit(1);
    }

    ensureNetwork(cfg, (l) => console.log(l));

    const { failedAgentImages, strictAgentPull } = pullImages(cfg, { onLog: (l) => console.log(l) });
    if (failedAgentImages.length > 0) {
        const list = failedAgentImages.map((t) => `    - ${t}`).join('\n');
        if (strictAgentPull) {
            console.error(`\nERROR: ${failedAgentImages.length} agent image(s) could not be pulled (PROPR_STRICT_AGENT_PULL is enabled):\n${list}`);
            console.error('  Build locally with scripts/build-images.sh or push to the registry.');
            console.error('  Set PROPR_STRICT_AGENT_PULL=false to allow startup without all agent images.\n');
            process.exit(1);
        }
        console.warn(`\nWARNING: ${failedAgentImages.length} agent image(s) could not be pulled (strict mode disabled):\n${list}`);
        console.warn('  Jobs using these agents will fail until images are available.\n');
    }

    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    console.log('\nstarting containers…');
    startStack(cfg, { ui: true, docs: cfg.docsEnabled, onLog: (l) => console.log(l) });

    console.log('\n[ok] stack up. streaming logs... (Ctrl-C to stop)');
    for (const svc of getStackStatus(cfg).services) {
        if (!svc.running) continue;
        const p = getServiceLogs(cfg, svc.service, { follow: true, tail: 0 });
        p.on('exit', () => {/* ignore — shutdown kills them */});
    }

    // Keep process alive until signal.
    await new Promise(() => {});
}

main().catch((e) => {
    console.error('launcher failed:', e.message);
    shutdown(1);
});
