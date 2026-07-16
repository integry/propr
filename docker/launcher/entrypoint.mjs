#!/usr/bin/env node
// Propr launcher: replaces docker-compose for production deployments.
//
// Runs INSIDE the propr/launcher container — uses the mounted docker socket to
// orchestrate sibling containers on the host's docker daemon. All the real
// logic lives in orchestrator.mjs (shared with the `propr` CLI); this file is a
// thin wrapper that wires it up for the containerized, log-streaming use case.

import { pathToFileURL } from 'node:url';
import {
    resolveConfig, validateEnv, ensureNetwork, pullImages,
    startStack, stopStack, getStackStatus, getServiceLogs,
    proprTunnelEndpoints,
} from './orchestrator.mjs';

let cfg;
let stackStarted = false;

function shutdown(code = 0) {
    console.log('\nshutting down…');
    if (cfg && stackStarted) {
        stopStack(cfg, { remove: true, removeNetwork: true, onLog: (l) => console.log(l) });
    }
    process.exit(code);
}

async function main() {
    cfg = resolveConfig(process.env);
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
            console.error('  Set PROPR_STRICT_AGENT_PULL=false to allow startup without the agent image.\n');
            process.exit(1);
        }
        console.warn(`\nWARNING: ${failedAgentImages.length} agent image(s) could not be pulled (strict mode disabled):\n${list}`);
        console.warn('  Jobs using these agents will fail until images are available.\n');
    }

    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    console.log('\nstarting containers…');
    startStack(cfg, { ui: true, docs: cfg.docsEnabled, onLog: (l) => console.log(l) });
    stackStarted = true;

    // Surface the concrete routed endpoints (not the base URL as a health
    // target) when the tunnel is on, so logs show where the hosted UI reaches it.
    if (cfg.uiTunnelEnabled && cfg.uiPublicApiUrl) {
        const { apiStatus, socketIo } = proprTunnelEndpoints(cfg.uiPublicApiUrl);
        console.log('\ntunnel is up — the hosted UI reaches this stack at:');
        console.log(`  API:       ${apiStatus}`);
        console.log(`  Socket.IO: ${socketIo}`);
        console.log('  Root URL intentionally returns 404.');
    }

    console.log('\n[ok] stack up. streaming logs... (Ctrl-C to stop)');
    for (const svc of getStackStatus(cfg).services) {
        if (!svc.running) continue;
        const p = getServiceLogs(cfg, svc.service, { follow: true, tail: 0 });
        p.on('exit', () => {/* ignore — shutdown kills them */});
    }

    // Keep process alive until signal.
    await new Promise(() => {});
}

// Guard against accidental execution on import (e.g. from tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error('launcher failed:', e.message);
        shutdown(1);
    });
}
