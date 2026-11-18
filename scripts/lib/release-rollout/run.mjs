// Runs the release rollout targets and renders their results.

import { checkDesktopPrerelease, checkGithubRelease } from './github.mjs';
import { STATUS, describeError, missing } from './http.mjs';
import { checkDockerImage, checkNpmPackage } from './registries.mjs';
import { checkHostedUiBundle, checkPage, checkPageLinks, checkStatusJson } from './web.mjs';

/** One check per target kind; a target table entry names its kind. */
export const CHECKS = Object.freeze({
  'github-release': checkGithubRelease,
  'desktop-prerelease': checkDesktopPrerelease,
  'docker-image': checkDockerImage,
  'npm-package': checkNpmPackage,
  'hosted-ui-bundle': checkHostedUiBundle,
  'status-json': checkStatusJson,
  page: checkPage,
  'page-links': checkPageLinks,
});

export async function runRollout({ targets, version, fetchImpl = fetch, repoRoot = process.cwd(), readFile, timeoutMs }) {
  const ctx = { version, fetchImpl, repoRoot, readFile, timeoutMs, cache: new Map() };
  return Promise.all(targets.map(async target => {
    const check = CHECKS[target.kind];
    if (!check) throw new Error(`target ${target.id} has unknown kind ${JSON.stringify(target.kind)}`);
    let result;
    try {
      result = await check(ctx, target);
    } catch (error) {
      result = missing(`could not check: ${describeError(error)}`);
    }
    return { id: target.id, kind: target.kind, status: result.status, found: result.found };
  }));
}

export const allOk = results => results.length > 0 && results.every(result => result.status === STATUS.ok);

export function formatText(results) {
  const statusWidth = Math.max(...Object.values(STATUS).map(status => status.length));
  const idWidth = Math.max(...results.map(result => result.id.length));
  return results.map(result => `${result.status.padEnd(statusWidth)}  ${result.id.padEnd(idWidth)}  ${result.found}`).join('\n');
}

export const formatJson = (version, results) => JSON.stringify({ version, ok: allOk(results), targets: results }, null, 2);

const cell = text => String(text).replace(/[\\|]/g, '\\$&').replace(/\r?\n/g, ' ');
const ICON = { [STATUS.ok]: '✅', [STATUS.missing]: '❌', [STATUS.stale]: '⚠️' };

/** Markdown for the GitHub Actions run summary. */
export function formatSummary(version, results) {
  const live = results.filter(result => result.status === STATUS.ok).length;
  return [
    `### Release rollout of ProPR ${version}`,
    '',
    `${live} of ${results.length} targets serve ${version}.`,
    '',
    '| Target | Status | Found |',
    '| --- | --- | --- |',
    ...results.map(result => `| \`${result.id}\` | ${ICON[result.status] ?? ''} ${result.status} | ${cell(result.found)} |`),
    '',
  ].join('\n');
}
