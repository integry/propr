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

import { DEFAULT_HOSTED_UI_URL, bundleHasVersion, checkOnce, requireVersion, resolveEntryBundle }
  from './lib/hosted-ui-bundle.mjs';

// The bundle check lives in scripts/lib/hosted-ui-bundle.mjs so the release
// rollout check (scripts/verify-release-rollout.mjs) runs the same one.
export { DEFAULT_HOSTED_UI_URL, bundleHasVersion, checkOnce, requireVersion, resolveEntryBundle };

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
