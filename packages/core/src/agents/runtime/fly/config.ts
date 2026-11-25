export function flyConfig(env: NodeJS.ProcessEnv) {
    const token = env.PROPR_FLY_API_TOKEN?.trim() || env.FLY_API_TOKEN?.trim();
    const app = env.PROPR_FLY_APP?.trim();
    const image = env.PROPR_FLY_IMAGE?.trim();
    if (!token || !app || !image) throw new Error('Set PROPR_FLY_API_TOKEN, PROPR_FLY_APP and PROPR_FLY_IMAGE on the worker');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) throw new Error('Invalid PROPR_FLY_APP');
    const size = /^(shared-cpu|performance)-([1-9]\d?)x$/.exec(env.PROPR_FLY_MACHINE_SIZE || 'shared-cpu-2x');
    if (!size) throw new Error('PROPR_FLY_MACHINE_SIZE must be shared-cpu-<n>x or performance-<n>x');
    const memory = Number(env.PROPR_FLY_MACHINE_MEMORY_MB || 2048);
    if (!Number.isSafeInteger(memory) || memory < 256) throw new Error('Invalid PROPR_FLY_MACHINE_MEMORY_MB');
    const credentialRetention = Number(env.PROPR_FLY_CREDENTIAL_RETENTION_SECONDS || 900);
    if (!Number.isSafeInteger(credentialRetention) || credentialRetention < 1) throw new Error('Invalid PROPR_FLY_CREDENTIAL_RETENTION_SECONDS');
    return { token, app, image, credentialRetention, region: env.PROPR_FLY_REGION || undefined,
        guest: { cpu_kind: size[1] === 'performance' ? 'performance' : 'shared', cpus: Number(size[2]), memory_mb: memory } };
}
export type FlyConfig = ReturnType<typeof flyConfig>;
