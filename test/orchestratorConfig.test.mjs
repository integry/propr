import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig, resolveHostConfig, validateEnv, buildServiceSpec, SERVICES, TOGGLE_SERVICES } from '../docker/launcher/orchestrator.mjs';

// Collect the values of `-e NAME=value` pairs for a given env var name from a
// service spec's docker run args.
function envValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1].startsWith(`${name}=`)) {
      values.push(args[i + 1].slice(name.length + 1));
    }
  }
  return values;
}

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

test('resolveHostConfig honors stack .env values for ports and docs', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'API_PORT=4400',
    'UI_PORT=5174',
    'DOCS_PORT=9090',
    'REDIS_EXTERNAL_PORT=6380',
    'DOCS_ENABLED=true',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });

  assert.equal(cfg.apiPort, '4400');
  assert.equal(cfg.uiPort, '5174');
  assert.equal(cfg.docsPort, '9090');
  assert.equal(cfg.redisExternalPort, '6380');
  assert.equal(cfg.docsEnabled, true);
});

test('process env values override stack .env values', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'API_PORT=4400',
    'DOCS_ENABLED=true',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({
    rootDir,
    env: { API_PORT: '4500', DOCS_ENABLED: 'false' },
    manifestPath,
  });

  assert.equal(cfg.apiPort, '4500');
  assert.equal(cfg.docsEnabled, false);
});

test('empty process env values override stack .env values before defaults apply', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), [
    'REDIS_EXTERNAL_PORT=6380',
    'HOST_OPENCODE_XDG_DIR=/from-env-file',
    '',
  ].join('\n'));

  const cfg = resolveHostConfig({
    rootDir,
    env: { REDIS_EXTERNAL_PORT: '', HOST_OPENCODE_XDG_DIR: '' },
    manifestPath,
  });

  assert.equal(cfg.redisExternalPort, '');
  assert.equal(cfg.hostOpencodeXdgDir, '');
});

test('empty explicit overrides win over env and defaults', () => {
  const cfg = resolveConfig({
    PROPR_STACK: 'from-env',
    API_PORT: '4400',
    UI_PORT: '5174',
    DOCS_PORT: '9090',
  }, {
    stack: '',
    apiPort: '',
    uiPort: '',
    docsPort: '',
    manifestPath,
  });

  assert.equal(cfg.stack, '');
  assert.equal(cfg.apiPort, '');
  assert.equal(cfg.uiPort, '');
  assert.equal(cfg.docsPort, '');
});

test('UI tunnel is disabled by default with local-development URL defaults intact', () => {
  const cfg = resolveConfig({ API_PORT: '4000', UI_PORT: '5173' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, false);
  assert.equal(cfg.uiTunnelToken, undefined);
  assert.equal(cfg.proprInstanceId, undefined);
  assert.equal(cfg.uiPublicApiUrl, undefined);
  assert.equal(cfg.cloudflaredImage, 'cloudflare/cloudflared:2024.12.2');
  // Local-development defaults must stay untouched and COOKIE_DOMAIN unset.
  assert.equal(cfg.apiPublicUrl, 'http://localhost:4000');
  assert.equal(cfg.frontendUrl, 'http://localhost:5173');
  assert.equal(cfg.cookieDomain, undefined);
});

test('enabling the tunnel derives public API, frontend, and OAuth callback URLs', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
  }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.apiPublicUrl, 'https://abc123.proxy.propr.dev');
  assert.equal(cfg.frontendUrl, 'https://app.propr.dev');
  assert.equal(cfg.ghOauthCallbackUrl, 'https://abc123.proxy.propr.dev/api/auth/github/callback');
});

test('explicit public URLs still win over tunnel-derived values', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
    API_PUBLIC_URL: 'https://api.example.com',
    FRONTEND_URL: 'https://ui.example.com',
    GH_OAUTH_CALLBACK_URL: 'https://api.example.com/api/auth/github/callback',
  }, { manifestPath });

  assert.equal(cfg.apiPublicUrl, 'https://api.example.com');
  assert.equal(cfg.frontendUrl, 'https://ui.example.com');
  assert.equal(cfg.ghOauthCallbackUrl, 'https://api.example.com/api/auth/github/callback');
});

test('tunnel enabled without a derivable public URL keeps the localhost API default', () => {
  // Enabled via the flag but no instance id / explicit URL ⇒ no proxy URL to
  // advertise, so the localhost default stands rather than a malformed value.
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: 'true', API_PORT: '4000', UI_PORT: '5173' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.uiPublicApiUrl, undefined);
  assert.equal(cfg.apiPublicUrl, 'http://localhost:4000');
  // The frontend still resolves to the hosted UI origin in tunnel mode.
  assert.equal(cfg.frontendUrl, 'https://app.propr.dev');
});

test('api container propagates the tunnel PROPR_UI_* env without the tunnel token', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
  }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(envValues(args, 'API_PUBLIC_URL'), ['https://abc123.proxy.propr.dev']);
  assert.deepEqual(envValues(args, 'FRONTEND_URL'), ['https://app.propr.dev']);
  assert.deepEqual(envValues(args, 'PROPR_UI_TUNNEL_ENABLED'), ['true']);
  assert.deepEqual(envValues(args, 'PROPR_INSTANCE_ID'), ['abc123']);
  assert.deepEqual(envValues(args, 'PROPR_UI_PUBLIC_API_URL'), ['https://abc123.proxy.propr.dev']);
  // The tunnel token must never reach the API container.
  assert.deepEqual(envValues(args, 'PROPR_UI_TUNNEL_TOKEN'), []);
});

test('api container gets a stable `api` network alias for the tunnel ingress target', () => {
  // cloudflared / the Cloudflare Tunnel ingress config target a fixed
  // http://api:4000 regardless of the stack prefix, so the API container must
  // carry an `api` network alias (it would otherwise only resolve as propr-api).
  const cfg = resolveConfig({ API_PORT: '4000' }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'api');
  const aliasIdx = args.indexOf('--network-alias');
  assert.notEqual(aliasIdx, -1, 'expected --network-alias in the api spec');
  assert.equal(args[aliasIdx + 1], 'api');
});

test('an explicit PROPR_UI_PUBLIC_API_URL is normalized (trailing slash stripped) once at resolve time', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_UI_PUBLIC_API_URL: 'https://abc123.proxy.propr.dev/',
  }, { manifestPath });
  assert.equal(cfg.uiPublicApiUrl, 'https://abc123.proxy.propr.dev');
  // and every consumer sees the canonical (no trailing slash) form.
  assert.deepEqual(envValues(buildServiceSpec(cfg, 'api').args, 'PROPR_UI_PUBLIC_API_URL'), ['https://abc123.proxy.propr.dev']);
  assert.deepEqual(envValues(buildServiceSpec(cfg, 'ui').args, 'PROPR_UI_PUBLIC_API_URL'), ['https://abc123.proxy.propr.dev']);
});

test('ui container receives the tunnel public API URL (no /api appended) when set', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
  }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'ui');

  // The UI bundle appends /api/... itself, so the container must get the bare
  // proxy origin — not the origin with /api on the end.
  assert.deepEqual(envValues(args, 'PROPR_UI_PUBLIC_API_URL'), ['https://abc123.proxy.propr.dev']);
});

test('ui container omits PROPR_UI_PUBLIC_API_URL in local development', () => {
  const cfg = resolveConfig({ API_PORT: '4000', UI_PORT: '5173' }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'ui');

  assert.deepEqual(envValues(args, 'PROPR_UI_PUBLIC_API_URL'), []);
});

test('api container reports the tunnel disabled and omits optional PROPR_* vars in local development', () => {
  const cfg = resolveConfig({ API_PORT: '4000', UI_PORT: '5173' }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(envValues(args, 'PROPR_UI_TUNNEL_ENABLED'), ['false']);
  assert.deepEqual(envValues(args, 'PROPR_INSTANCE_ID'), []);
  assert.deepEqual(envValues(args, 'PROPR_UI_PUBLIC_API_URL'), []);
  assert.deepEqual(envValues(args, 'API_PUBLIC_URL'), ['http://localhost:4000']);
});

test('worker API_PUBLIC_URL aligns with the proxy URL in tunnel mode', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
  }, { manifestPath });
  const { args } = buildServiceSpec(cfg, 'worker');

  assert.deepEqual(envValues(args, 'API_PUBLIC_URL'), ['https://abc123.proxy.propr.dev']);
  // The worker never receives the tunnel token either.
  assert.deepEqual(envValues(args, 'PROPR_UI_TUNNEL_TOKEN'), []);
});

test('only the tunnel sidecar receives the token, via cloudflared TUNNEL_TOKEN', () => {
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
  }, { manifestPath });
  const spec = buildServiceSpec(cfg, 'tunnel');

  // cloudflared reads its token from TUNNEL_TOKEN, not PROPR_UI_TUNNEL_TOKEN.
  assert.deepEqual(envValues(spec.args, 'TUNNEL_TOKEN'), ['secret-token']);
  assert.deepEqual(envValues(spec.args, 'PROPR_UI_TUNNEL_TOKEN'), []);
  // The token must not appear in the container argv (visible via docker inspect).
  assert.ok(!spec.command.includes('--token'));
  assert.ok(!spec.command.includes('secret-token'));
});

test('buildServiceSpec throws for a tunnel without a token', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: 'true' }, { manifestPath });
  assert.throws(() => buildServiceSpec(cfg, 'tunnel'), /PROPR_UI_TUNNEL_TOKEN is not set/);
});

test('PROPR_UI_TUNNEL_TOKEN alone enables the tunnel', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'secret-token' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.uiTunnelToken, 'secret-token');
});

test('PROPR_UI_TUNNEL_ENABLED=true enables the tunnel without a token', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: 'true' }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.equal(cfg.uiTunnelToken, undefined);
});

test('PROPR_UI_TUNNEL_ENABLED accepts broad truthy forms (1, TRUE, padded)', () => {
  for (const value of ['1', 'TRUE', ' true ']) {
    const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: value }, { manifestPath });
    assert.equal(cfg.uiTunnelEnabled, true, `expected ${JSON.stringify(value)} to enable the tunnel`);
  }
});

test('PROPR_UI_TUNNEL_ENABLED stays disabled for non-truthy values', () => {
  for (const value of ['false', '0', 'no', '']) {
    const cfg = resolveConfig({ PROPR_UI_TUNNEL_ENABLED: value }, { manifestPath });
    assert.equal(cfg.uiTunnelEnabled, false, `expected ${JSON.stringify(value)} to leave the tunnel disabled`);
  }
});

test('a persisted uiTunnelEnabled override wins over the env-derived default', () => {
  // `propr tunnel off` persists tunnelEnabled=false; getHostConfig forwards it
  // as a uiTunnelEnabled override that must win even when a token is present.
  const off = resolveConfig(
    { PROPR_UI_TUNNEL_TOKEN: 'secret-token' },
    { manifestPath, uiTunnelEnabled: false }
  );
  assert.equal(off.uiTunnelEnabled, false);
  assert.equal(off.uiTunnelToken, 'secret-token');

  // `propr tunnel on` persists tunnelEnabled=true; the override enables it.
  const on = resolveConfig({}, { manifestPath, uiTunnelEnabled: true });
  assert.equal(on.uiTunnelEnabled, true);
});

test('an absent uiTunnelEnabled override falls back to the env-derived default', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'secret-token' }, { manifestPath });
  assert.equal(cfg.uiTunnelEnabled, true);
});

test('PROPR_INSTANCE_ID derives the proxy public API URL when none is explicit', () => {
  const cfg = resolveConfig({ PROPR_INSTANCE_ID: 'abc123' }, { manifestPath });

  assert.equal(cfg.proprInstanceId, 'abc123');
  assert.equal(cfg.uiPublicApiUrl, 'https://abc123.proxy.propr.dev');
});

test('an invalid PROPR_INSTANCE_ID does not derive a malformed public URL', () => {
  for (const id of ['bad id', 'has/slash', 'under_score', 'has.dot', '-leading', 'trailing-']) {
    const cfg = resolveConfig({ PROPR_INSTANCE_ID: id }, { manifestPath });
    assert.equal(cfg.proprInstanceId, id, 'the raw instance id is still surfaced');
    assert.equal(cfg.uiPublicApiUrl, undefined, `expected no derived URL for invalid id ${JSON.stringify(id)}`);
  }
});

test('PROPR_UI_PUBLIC_API_URL overrides the instance-id-derived URL', () => {
  const cfg = resolveConfig({
    PROPR_INSTANCE_ID: 'abc123',
    PROPR_UI_PUBLIC_API_URL: 'https://custom.example.com',
  }, { manifestPath });

  assert.equal(cfg.uiPublicApiUrl, 'https://custom.example.com');
});

test('PROPR_CLOUDFLARED_IMAGE overrides the manifest cloudflared image', () => {
  const cfg = resolveConfig({ PROPR_CLOUDFLARED_IMAGE: 'cloudflare/cloudflared:2024.1.0' }, { manifestPath });

  assert.equal(cfg.cloudflaredImage, 'cloudflare/cloudflared:2024.1.0');
});

test('cloudflared image is pinned from the manifest by default', () => {
  const cfg = resolveConfig({}, { manifestPath });

  // The resolved image comes from the manifest's pinned `cloudflared` entry.
  assert.equal(cfg.cloudflaredImage, cfg.images.cloudflared);
  assert.equal(cfg.cloudflaredImage, 'cloudflare/cloudflared:2024.12.2');
});

test('tunnel is part of the optional service registry', () => {
  assert.ok(TOGGLE_SERVICES.includes('tunnel'));
  assert.ok(SERVICES.includes('tunnel'));
});

test('validateEnv rejects a tunnel enabled without a token', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_ENABLED: 'true',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  assert.equal(cfg.uiTunnelEnabled, true);
  assert.match(validateEnv(cfg).errors.join('\n'), /PROPR_UI_TUNNEL_TOKEN/);
});

test('validateEnv accepts a tunnel enabled with a token and a derivable public URL', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  // A complete tunnel config: token + instance id (which derives the public proxy
  // URL). Both are required now — a token alone with no derivable public URL is a
  // hard error (see the dedicated rejection test below).
  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  assert.deepEqual(validateEnv(cfg).errors, []);
});

test('validateEnv rejects a malformed explicit PROPR_UI_PUBLIC_API_URL in tunnel mode', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_UI_PUBLIC_API_URL: 'not a url',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  assert.match(validateEnv(cfg).errors.join('\n'), /PROPR_UI_PUBLIC_API_URL/);
});

test('validateEnv only warns about a malformed PROPR_UI_PUBLIC_API_URL when the tunnel is off', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  // A leftover/typo'd PROPR_UI_PUBLIC_API_URL with the tunnel disabled is inert —
  // nothing consumes it — so it must not hard-fail an unrelated local-dev startup;
  // it is only surfaced as a warning.
  const disabled = resolveConfig({
    PROPR_UI_PUBLIC_API_URL: 'not a url',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });
  assert.equal(disabled.uiTunnelEnabled, false);
  assert.deepEqual(validateEnv(disabled).errors.filter((e) => /PROPR_UI_PUBLIC_API_URL/.test(e)), []);
  assert.match(validateEnv(disabled).warnings.join('\n'), /PROPR_UI_PUBLIC_API_URL.*not a valid http\(s\) URL/);
});

test('validateEnv accepts a derived public URL from the instance id', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  assert.equal(cfg.uiPublicApiUrl, 'https://abc123.proxy.propr.dev');
  assert.deepEqual(validateEnv(cfg).errors, []);
});

test('validateEnv rejects a tunnel enabled but with no public URL derivable', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const base = {
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  };

  // Missing instance id and no explicit URL — a hard error, because `propr start`
  // enables the tunnel from the token alone and would otherwise bring up a
  // tunnel-mode stack whose API advertises localhost (no endpoint for the hosted
  // UI). This is the higher-risk path the stricter `propr tunnel on` guard misses.
  const missing = resolveConfig(base, { manifestPath });
  assert.match(validateEnv(missing).errors.join('\n'), /neither PROPR_INSTANCE_ID nor PROPR_UI_PUBLIC_API_URL/);

  // Invalid (non-DNS-label) instance id and no explicit URL — also a hard error.
  const invalid = resolveConfig({ ...base, PROPR_INSTANCE_ID: 'not a label' }, { manifestPath });
  assert.equal(invalid.uiPublicApiUrl, undefined);
  assert.match(validateEnv(invalid).errors.join('\n'), /not a valid DNS label/);

  // A valid explicit proxy URL silences the "no public URL derivable" error even
  // with an invalid id (uiPublicApiUrl is then defined and routable).
  const explicit = resolveConfig(
    { ...base, PROPR_INSTANCE_ID: 'not a label', PROPR_UI_PUBLIC_API_URL: 'https://custom.proxy.propr.dev' },
    { manifestPath },
  );
  assert.deepEqual(validateEnv(explicit).errors, []);
});

test('validateEnv rejects a tunnel public URL that is not a hosted proxy URL', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const base = {
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  };

  // A valid http(s) URL that is not under proxy.propr.dev is a hard error in
  // tunnel mode — propr-routing will not forward to it, so the stack would start
  // with an unroutable public base. Matches the documented routing requirement.
  const offProxy = resolveConfig({ ...base, PROPR_UI_PUBLIC_API_URL: 'https://custom.example.com' }, { manifestPath });
  assert.match(validateEnv(offProxy).errors.join('\n'), /not a hosted proxy URL/);

  // A proper per-instance proxy URL produces no such error.
  const onProxy = resolveConfig({ ...base, PROPR_UI_PUBLIC_API_URL: 'https://abc123.proxy.propr.dev' }, { manifestPath });
  assert.deepEqual(validateEnv(onProxy).errors.filter((e) => /not a hosted proxy URL/.test(e)), []);

  // The proxy-pattern check only applies in tunnel mode; a non-proxy URL with the
  // tunnel disabled is inert, so it produces neither an error nor a warning.
  const disabled = resolveConfig({ PROPR_UI_PUBLIC_API_URL: 'https://custom.example.com', PROPR_LAUNCHER_ENV_FILE: envFileLocal, PROPR_ENV_FILE: '/host/propr/.env', PROPR_DATA_DIR: '/host/propr/data', PROPR_LOGS_DIR: '/host/propr/logs', PROPR_REPOS_DIR: '/host/propr/repos' }, { manifestPath });
  assert.equal(disabled.uiTunnelEnabled, false);
  assert.deepEqual(validateEnv(disabled).errors.filter((e) => /not a hosted proxy URL/.test(e)), []);
  assert.deepEqual(validateEnv(disabled).warnings.filter((w) => /not a hosted proxy URL/.test(w)), []);
});

test('validateEnv warns when GH_OAUTH_CALLBACK_URL still points at localhost in tunnel mode', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const base = {
    PROPR_UI_TUNNEL_TOKEN: 'secret-token',
    PROPR_INSTANCE_ID: 'abc123',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  };

  // An explicit stale localhost callback is a common broken-OAuth setup once the
  // tunnel is on. Warn (not error).
  const localhostCallback = resolveConfig(
    { ...base, GH_OAUTH_CALLBACK_URL: 'http://localhost:4400/api/auth/github/callback' },
    { manifestPath },
  );
  assert.deepEqual(validateEnv(localhostCallback).errors, []);
  assert.match(validateEnv(localhostCallback).warnings.join('\n'), /GH_OAUTH_CALLBACK_URL.*localhost/);

  // Without an explicit value, the launcher derives the proxy callback in tunnel
  // mode, so no manual .env edit is required.
  const derivedCallback = resolveConfig(base, { manifestPath });
  assert.equal(derivedCallback.ghOauthCallbackUrl, 'https://abc123.proxy.propr.dev/api/auth/github/callback');
  assert.deepEqual(validateEnv(derivedCallback).warnings.filter((w) => /GH_OAUTH_CALLBACK_URL/.test(w)), []);

  // An explicit public callback URL silences the warning.
  const publicCallback = resolveConfig(
    { ...base, GH_OAUTH_CALLBACK_URL: 'https://abc123.proxy.propr.dev/api/auth/github/callback' },
    { manifestPath },
  );
  assert.deepEqual(validateEnv(publicCallback).warnings.filter((w) => /GH_OAUTH_CALLBACK_URL/.test(w)), []);

  // The warning only applies in tunnel mode; the localhost default is fine when
  // the tunnel is off.
  const disabled = resolveConfig({ PROPR_LAUNCHER_ENV_FILE: envFileLocal, PROPR_ENV_FILE: '/host/propr/.env', PROPR_DATA_DIR: '/host/propr/data', PROPR_LOGS_DIR: '/host/propr/logs', PROPR_REPOS_DIR: '/host/propr/repos' }, { manifestPath });
  assert.equal(disabled.uiTunnelEnabled, false);
  assert.deepEqual(validateEnv(disabled).warnings.filter((w) => /GH_OAUTH_CALLBACK_URL/.test(w)), []);
});

test('derived proxy URL lowercases a mixed-case instance id', () => {
  const cfg = resolveConfig({ PROPR_UI_TUNNEL_TOKEN: 'secret-token', PROPR_INSTANCE_ID: 'AbC123' }, { manifestPath });
  assert.equal(cfg.uiPublicApiUrl, 'https://abc123.proxy.propr.dev');
});

test('launcher config does not stat host bind paths inside the launcher container', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
    HOST_GH_PRIVATE_KEY: '/host/propr/key.pem',
  }, { manifestPath });

  assert.equal(cfg.validateHostPaths, false);
  assert.deepEqual(validateEnv(cfg).errors, []);
});

test('host config validates stack directories on the host', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  writeFileSync(join(rootDir, '.env'), 'API_PORT=4400\n');
  mkdirSync(join(rootDir, 'data'));
  mkdirSync(join(rootDir, 'logs'));

  const cfg = resolveHostConfig({ rootDir, env: {}, manifestPath });

  assert.equal(cfg.validateHostPaths, true);
  assert.match(validateEnv(cfg).errors.join('\n'), /PROPR_REPOS_DIR/);
});

test('validateEnv rejects stack names that are not valid Docker names', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'propr-orch-'));
  const envFileLocal = join(rootDir, '.env');
  writeFileSync(envFileLocal, 'API_PORT=4400\n');

  const cfg = resolveConfig({
    PROPR_STACK: 'bad name!',
    PROPR_ENV_FILE: '/host/propr/.env',
    PROPR_LAUNCHER_ENV_FILE: envFileLocal,
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
  }, { manifestPath });

  const errors = validateEnv(cfg).errors.join('\n');
  assert.match(errors, /PROPR_STACK/);
  assert.match(errors, /PROPR_NETWORK/);
});
