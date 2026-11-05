#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const advisoryUrl = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const expires = '2026-10-17T00:00:00Z';

// Temporary risk acceptance, not a vulnerability remediation. See
// docs/dependency-audit-exceptions.md before extending or changing this policy.
export function evaluateAudit(report, { level, now = new Date() }) {
  if (report?.error || report?.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' ||
      Array.isArray(report.vulnerabilities) || !severities.includes(level) ||
      !Number.isFinite(now.getTime())) {
    throw new Error('Invalid or unsuccessful npm audit report');
  }
  const entries = Object.entries(report.vulnerabilities);
  for (const [name, vulnerability] of entries) {
    if (vulnerability?.name !== name || !severities.includes(vulnerability.severity) ||
        !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
      throw new Error(`Invalid audit entry: ${name}`);
    }
    for (const cause of vulnerability.via) {
      if (typeof cause === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, cause)) {
          throw new Error(`Missing audit dependency: ${cause}`);
        }
      } else if (!cause || typeof cause.url !== 'string' || typeof cause.name !== 'string' ||
                 !severities.includes(cause.severity)) {
        throw new Error(`Invalid advisory for ${name}`);
      }
    }
  }

  function isExcepted(name, ancestors = new Set()) {
    // Cyclic or unrecognized dependency chains must never be silently accepted.
    if (ancestors.has(name)) return false;
    const visited = new Set([...ancestors, name]);
    const vulnerability = report.vulnerabilities[name];
    return vulnerability.via.every(cause => {
      if (typeof cause === 'string') return isExcepted(cause, visited);
      return name === 'braces' && cause.name === 'braces' &&
        cause.url === advisoryUrl && cause.range === '<=3.0.3' &&
        cause.severity === 'high' && vulnerability.fixAvailable === false &&
        now.getTime() < Date.parse(expires);
    });
  }

  const accepted = [];
  const blocking = [];
  for (const [name, vulnerability] of entries) {
    if (isExcepted(name)) accepted.push(name);
    else if (severities.indexOf(vulnerability.severity) >= severities.indexOf(level)) blocking.push(name);
  }
  return { accepted, blocking };
}

export function runAudit(mode, { run = spawnSync, now = new Date() } = {}) {
  const level = mode === 'runtime' ? 'low' : 'high';
  if (!['runtime', 'packaging'].includes(mode)) throw new Error('Expected runtime or packaging audit mode');
  // npm_execpath lets npm run use the same npm CLI on Windows, macOS and Linux.
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run audit:runtime or desktop:audit:packaging');
  const args = ['audit', '--package-lock-only', '--json', `--audit-level=${level}`,
    ...(mode === 'runtime' ? ['--omit=dev'] : ['--workspace=@propr/desktop', '--include=dev'])];
  const result = run(process.execPath, [process.env.npm_execpath, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit failed: ${result.error?.message || result.signal || result.status}`);
  }
  const report = JSON.parse(result.stdout);
  const { accepted, blocking } = evaluateAudit(report, { level, now });
  if (result.status === 1 && Object.keys(report.vulnerabilities).length === 0) {
    throw new Error('npm audit failed without vulnerability details');
  }
  if (accepted.length) {
    console.warn(`Temporary exception until ${expires}: ${advisoryUrl}\nAffected packages: ${accepted.join(', ')}\nThe underlying vulnerability remains present.`);
  }
  if (blocking.length) {
    console.error(JSON.stringify(report, null, 2));
    console.error(`Blocking vulnerabilities: ${blocking.join(', ')}`);
    return 1;
  }
  console.log(`${mode} dependency audit passed${accepted.length ? ' with the documented temporary exception' : ''}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runAudit(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
