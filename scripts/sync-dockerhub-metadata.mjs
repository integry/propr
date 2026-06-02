#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`Usage: scripts/sync-dockerhub-metadata.mjs [--dry-run] [--only app,ui]

Environment:
  DOCKERHUB_USERNAME  Docker Hub username used to authenticate
  DOCKERHUB_TOKEN     Docker Hub personal access token
  DOCKERHUB_NS        Docker Hub namespace to update, defaults to propr
`);
}

function parseArgs(argv) {
  const options = { dryRun: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new Error('--only requires a comma-separated value');
      options.only = new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function dockerHubLoginToken(username, token) {
  const response = await fetch('https://hub.docker.com/v2/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: token }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/v2/users/login failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body);
  if (!parsed.token) {
    throw new Error('/v2/users/login response did not include token');
  }
  return parsed.token;
}

async function dockerHubScopedToken(username, token) {
  const response = await fetch('https://hub.docker.com/v2/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, secret: token }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Docker Hub authentication failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body);
  if (!parsed.access_token) {
    throw new Error('Docker Hub authentication response did not include access_token');
  }
  return parsed.access_token;
}

async function dockerHubAuthCandidates(username, token) {
  const candidates = [];
  const failures = [];

  try {
    const loginToken = await dockerHubLoginToken(username, token);
    candidates.push({
      label: 'Docker Hub account login token',
      authorization: `JWT ${loginToken}`,
    });
  } catch (error) {
    failures.push(error.message);
  }

  try {
    const scopedToken = await dockerHubScopedToken(username, token);
    candidates.push({
      label: 'Docker Hub scoped bearer token',
      authorization: `Bearer ${scopedToken}`,
    });
  } catch (error) {
    failures.push(error.message);
  }

  if (candidates.length === 0) {
    throw new Error(`Docker Hub authentication failed\n${failures.join('\n')}`);
  }

  return candidates;
}

async function patchJson(url, authorization, payload) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

async function updateRepository(namespace, authCandidates, repo, payload) {
  const endpoints = [
    `https://hub.docker.com/v2/repositories/${namespace}/${repo}/`,
    `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repo}`,
  ];

  const failures = [];
  for (const auth of authCandidates) {
    for (const endpoint of endpoints) {
      const result = await patchJson(endpoint, auth.authorization, payload);
      if (result.ok) return { endpoint, authLabel: auth.label };
      failures.push(`${auth.label}: ${endpoint} -> ${result.status}: ${result.body}`);

      if (![403, 404, 405].includes(result.status)) break;
    }
  }

  const hint = failures.some((failure) => failure.includes('insufficient scope'))
    ? '\n\nDocker Hub accepted the credentials but rejected repository metadata updates. Image push tokens may not be enough here; this endpoint appears to require repository admin scope for the namespace.'
    : '';
  throw new Error(`Failed to update ${namespace}/${repo}\n${failures.join('\n')}${hint}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const namespace = process.env.DOCKERHUB_NS || 'propr';
  const metadataDir = path.join(repoRoot, 'dockerhub');
  const manifest = await readJson(path.join(metadataDir, 'repositories.json'));

  const repositories = options.only
    ? manifest.filter((repo) => options.only.has(repo.name))
    : manifest;

  if (repositories.length === 0) {
    throw new Error('No repositories selected for Docker Hub metadata sync');
  }

  if (options.dryRun) {
    console.log(`Docker Hub metadata dry run for namespace ${namespace}`);
  } else if (!process.env.DOCKERHUB_USERNAME || !process.env.DOCKERHUB_TOKEN) {
    throw new Error('DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required');
  }

  const authCandidates = options.dryRun
    ? null
    : await dockerHubAuthCandidates(process.env.DOCKERHUB_USERNAME, process.env.DOCKERHUB_TOKEN);

  for (const repo of repositories) {
    if (!repo.name || !repo.description || !repo.overview) {
      throw new Error(`Invalid Docker Hub repository metadata: ${JSON.stringify(repo)}`);
    }
    if (repo.description.length > 100) {
      throw new Error(`${repo.name} description exceeds Docker Hub's 100 character limit`);
    }

    const fullDescription = await fs.readFile(path.join(metadataDir, repo.overview), 'utf8');
    const payload = {
      description: repo.description,
      full_description: fullDescription,
    };

    if (options.dryRun) {
      console.log(`- ${namespace}/${repo.name}: ${repo.description}`);
      continue;
    }

    const result = await updateRepository(namespace, authCandidates, repo.name, payload);
    console.log(`updated ${namespace}/${repo.name} via ${result.endpoint} (${result.authLabel})`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
