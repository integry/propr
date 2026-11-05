import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAudit, runAudit } from '../scripts/audit-dependencies.mjs';

const now = new Date('2026-10-03T12:00:00Z');
const options = { level: 'low', now };
const advisory = {
  name: 'braces', severity: 'high', range: '<=3.0.3',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};
const entry = (name, via, severity = 'high') => ({ name, severity, via, fixAvailable: false });
const fixture = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    braces: entry('braces', [{ ...advisory }]),
    chokidar: { ...entry('chokidar', ['braces']), fixAvailable: { version: '5.0.0' } },
    micromatch: entry('micromatch', ['braces']),
    'fast-glob': entry('fast-glob', ['micromatch']),
    globby: entry('globby', ['fast-glob']),
    repomix: entry('repomix', ['globby']),
  },
});

function mockNpmPath(t) {
  const original = process.env.npm_execpath;
  process.env.npm_execpath = '/npm-cli.js';
  t.after(() => {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  });
}

test('accepts only the exact advisory and its transitive consequences', () => {
  const report = fixture();
  const result = evaluateAudit(report, options);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.accepted, Object.keys(report.vulnerabilities));
});

test('another advisory on braces blocks the whole affected chain', () => {
  const report = fixture();
  report.vulnerabilities.braces.via.push({ ...advisory, url: 'https://github.com/advisories/another' });
  assert.deepEqual(evaluateAudit(report, options).blocking, Object.keys(report.vulnerabilities));
});

test('another cause on a dependent package is not hidden', () => {
  const report = fixture();
  report.vulnerabilities.micromatch.via.push({ ...advisory, name: 'micromatch', url: 'https://github.com/advisories/another' });
  assert.deepEqual(evaluateAudit(report, options).blocking, ['micromatch', 'fast-glob', 'globby', 'repomix']);
});

test('expiry, an available braces fix, or advisory changes restore blocking', () => {
  assert.equal(evaluateAudit(fixture(), { ...options, now: new Date('2026-10-17T00:00:00Z') }).blocking.length, 6);
  for (const change of [
    report => { report.vulnerabilities.braces.fixAvailable = true; },
    report => { report.vulnerabilities.braces.via[0].range = '<=3.0.4'; },
    report => { report.vulnerabilities.braces.via[0].severity = 'critical'; },
  ]) {
    const report = fixture();
    change(report);
    assert.equal(evaluateAudit(report, options).blocking.length, 6);
  }
});

test('preserves runtime and packaging severity thresholds for other findings', () => {
  const report = fixture();
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    report.vulnerabilities[severity] = entry(severity, [{ name: severity, severity, url: `https://example.com/${severity}` }], severity);
  }
  assert.deepEqual(evaluateAudit(report, options).blocking, ['low', 'moderate', 'high', 'critical']);
  assert.deepEqual(evaluateAudit(report, { ...options, level: 'high' }).blocking, ['high', 'critical']);
});

test('rejects malformed reports, missing dependencies and malformed advisory entries', () => {
  for (const report of [
    {}, { ...fixture(), error: { summary: 'registry unavailable' } },
    { ...fixture(), auditReportVersion: 3 },
    { auditReportVersion: 2, vulnerabilities: [] },
    { auditReportVersion: 2, vulnerabilities: { braces: entry('braces', []) } },
    { auditReportVersion: 2, vulnerabilities: { braces: entry('braces', ['missing']) } },
    { auditReportVersion: 2, vulnerabilities: { braces: entry('braces', [null]) } },
  ]) assert.throws(() => evaluateAudit(report, options));
});

test('cycles cannot qualify for an exception', () => {
  const report = fixture();
  report.vulnerabilities.braces.via.push('repomix');
  assert.equal(evaluateAudit(report, options).blocking.length, 6);
});

test('runs npm against the lockfile with the original scope and accepts audit exit 1 only after evaluation', t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  mockNpmPath(t);
  for (const mode of ['runtime', 'packaging']) {
    const run = (command, args) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['/npm-cli.js', 'audit', '--package-lock-only', '--json',
        ...(mode === 'runtime' ? ['--audit-level=low', '--omit=dev'] : ['--audit-level=high', '--workspace=@propr/desktop', '--include=dev'])]);
      return { status: 1, stdout: JSON.stringify(fixture()) };
    };
    assert.equal(runAudit(mode, { run, now }), 0);
    assert.equal(runAudit(mode, { run, now: new Date('2026-10-17') }), 1);
  }
});

test('npm execution and registry errors fail closed', t => {
  mockNpmPath(t);
  for (const result of [
    { status: 1, stdout: JSON.stringify({ error: { summary: 'network failure' } }) },
    { status: 1, stdout: '<html>Bad Gateway</html>' },
    { status: 2, stdout: JSON.stringify(fixture()) },
    { status: null, signal: 'SIGTERM', stdout: '' },
    { status: null, error: new Error('ENOENT'), stdout: '' },
    { status: 1, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }) },
  ]) assert.throws(() => runAudit('runtime', { run: () => result, now }));
});
