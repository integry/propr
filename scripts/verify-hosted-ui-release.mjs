#!/usr/bin/env node
// Post-deploy check for the hosted UI (app.propr.dev) release job.
//
// Fetches the hosted index.html, resolves the entry module it loads
// (/assets/index-<hash>.js) and asserts the bundle embeds the released
// version as the JSON string literal vite writes for __APP_VERSION__. The
// edge can serve the previous deployment for a short while, so the check
// retries before failing.
//
//   RELEASE_VERSION=0.9.0 node scripts/verify-hosted-ui-release.mjs
//
// Optional: HOSTED_UI_URL (default https://app.propr.dev/),
// VERIFY_ATTEMPTS (default 6), VERIFY_DELAY_SECONDS (default 20).

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HOSTED_UI_URL = 'https://app.propr.dev/';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']*\/assets\/index-[\w-]+\.js)["'][^>]*>/i;

export function requireVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`RELEASE_VERSION must be a release version such as 0.9.0, got ${JSON.stringify(version)}`);
  }
  return version;
}

export function resolveEntryBundle(html, pageUrl) {
  const match = ENTRY_SCRIPT.exec(html);
  if (!match) throw new Error('index.html does not load an /assets/index-*.js entry module');
  const bundle = new URL(match[1], pageUrl);
  if (bundle.origin !== new URL(pageUrl).origin) {
    throw new Error(`entry module ${bundle.href} is not served from ${new URL(pageUrl).origin}`);
  }
  return bundle;
}

export const bundleHasVersion = (source, version) => source.includes(JSON.stringify(version));

async function fetchText(fetchImpl, url) {
  // Bypass intermediate caches so each attempt sees the current deployment.
  const busted = new URL(url);
  busted.searchParams.set('propr_release_check', String(Date.now()));
  const response = await fetchImpl(busted, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response.text();
}

export async function checkOnce({ url, version, fetchImpl = fetch }) {
  const bundle = resolveEntryBundle(await fetchText(fetchImpl, url), url);
  const source = await fetchText(fetchImpl, bundle);
  if (!bundleHasVersion(source, version)) {
    throw new Error(`${bundle.pathname} does not contain ${JSON.stringify(version)}`);
  }
  return bundle;
}

export async function verifyHostedUi({
  url = DEFAULT_HOSTED_UI_URL,
  version,
  attempts = 6,
  delayMs = 20_000,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = message => console.log(message),
}) {
  requireVersion(version);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const bundle = await checkOnce({ url, version, fetchImpl });
      log(`Attempt ${attempt}/${attempts}: ${bundle.href} contains ${JSON.stringify(version)}.`);
      return bundle;
    } catch (error) {
      lastError = error;
      log(`Attempt ${attempt}/${attempts}: ${error.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`${url} is not serving ProPR ${version} after ${attempts} attempts: ${lastError.message}`);
}

const positiveInteger = (value, fallback, label) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
};

async function main() {
  const version = requireVersion(process.env.RELEASE_VERSION);
  const url = process.env.HOSTED_UI_URL || DEFAULT_HOSTED_UI_URL;
  const bundle = await verifyHostedUi({
    url,
    version,
    attempts: positiveInteger(process.env.VERIFY_ATTEMPTS, 6, 'VERIFY_ATTEMPTS'),
    delayMs: positiveInteger(process.env.VERIFY_DELAY_SECONDS, 20, 'VERIFY_DELAY_SECONDS') * 1000,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Hosted UI\n\n${url} serves ProPR ${version} (\`${bundle.pathname}\`).\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
