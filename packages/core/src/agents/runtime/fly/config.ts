/**
 * The ProPR MCP endpoint agent Machines reach over the org's private network (6PN, IPv6).
 * `propr deploy fly` runs the worker and the API in the same container of one Machine (the
 * `app` process group), so the worker's own Machine is the API's: its `<machine id>.vm.<app>.internal`
 * name resolves from Machines in the org's other apps. Without a Machine id, the worker's
 * process group (`FLY_PROCESS_GROUP`, default `app`) names it. A split API sets PROPR_FLY_MCP_URL.
 */
export function flyMcpEndpoint(env: NodeJS.ProcessEnv) {
    const explicit = env.PROPR_FLY_MCP_URL?.trim();
    if (explicit) return explicit;
    if (env.PROPR_AGENT_MCP_URL?.trim() && !env.PROPR_AGENT_DOCKER_NETWORK?.trim()) return;
    const app = env.FLY_APP_NAME?.trim();
    if (!app || !env.FLY_PRIVATE_IP) return;
    const machine = env.FLY_MACHINE_ID?.trim();
    const host = machine ? `${machine}.vm.${app}.internal` : `${env.FLY_PROCESS_GROUP?.trim() || 'app'}.process.${app}.internal`;
    return `http://${host}:${env.DASHBOARD_API_PORT || '4000'}/api/mcp`;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, [min, max] = [1, Number.MAX_SAFE_INTEGER]) {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid ' + name);
    return value;
}

export function flyConfig(env: NodeJS.ProcessEnv) {
    const token = env.PROPR_FLY_API_TOKEN?.trim() || env.FLY_API_TOKEN?.trim();
    const app = env.PROPR_FLY_APP?.trim();
    const image = env.PROPR_FLY_IMAGE?.trim();
    if (!token || !app || !image) throw new Error('Set PROPR_FLY_API_TOKEN, PROPR_FLY_APP and PROPR_FLY_IMAGE on the worker');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) throw new Error('Invalid PROPR_FLY_APP');
    const size = /^(shared-cpu|performance)-([1-9]\d?)x$/.exec(env.PROPR_FLY_MACHINE_SIZE || 'shared-cpu-2x');
    if (!size) throw new Error('PROPR_FLY_MACHINE_SIZE must be shared-cpu-<n>x or performance-<n>x');
    const memory = positiveInteger(env, 'PROPR_FLY_MACHINE_MEMORY_MB', 2048, [256, Number.MAX_SAFE_INTEGER]);
    const credentialRetention = positiveInteger(env, 'PROPR_FLY_CREDENTIAL_RETENTION_SECONDS', 900);
    const bootSeconds = positiveInteger(env, 'PROPR_FLY_BOOT_TIMEOUT', 300, [1, Math.floor((2 ** 31 - 1) / 1000)]);
    return { token, app, image, bootTimeout: bootSeconds * 1000, credentialRetention, region: env.PROPR_FLY_REGION || undefined,
        guest: { cpu_kind: size[1] === 'performance' ? 'performance' : 'shared', cpus: Number(size[2]), memory_mb: memory } };
}
export type FlyConfig = ReturnType<typeof flyConfig>;
