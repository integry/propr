import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { TARGETS, main, parseArgs } from '../scripts/verify-release-rollout.mjs';
import { formatSummary, formatText, runRollout } from '../scripts/lib/release-rollout/run.mjs';

const VERSION = '0.9.2';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;
const SUMMARY = '## Highlights\n\nProPR 0.9.2 does things.\n\n## Upgrade notes\n\nNone.\n';
const target = id => {
  const found = TARGETS.find(candidate => candidate.id === id);
  assert.ok(found, `missing target ${id}`);
  return found;
};

const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const text = (body, status = 200) => ({ status, body });
const NOT_FOUND = { status: 404, body: '{"message":"Not Found"}' };

/** A fetch that serves `routes` (URL without the cache-busting query → response) and records requests. */
function mockFetch(routes) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    url.searchParams.delete('propr_release_check');
    const key = url.href;
    requests.push({ url: key, headers: init.headers ?? {} });
    const route = routes[key] ?? NOT_FOUND;
    if (route instanceof Error) throw route;
    return new Response(route.body, { status: route.status });
  };
  return { fetchImpl, requests };
}

const run = async (ids, routes, extra = {}) => {
  const { fetchImpl, requests } = mockFetch(routes);
  const results = await runRollout({
    targets: ids.map(target),
    version: VERSION,
    fetchImpl,
    repoRoot: '/nonexistent',
    readFile: async () => { throw new Error('ENOENT'); },
    ...extra,
  });
  return { results, requests, result: results[0] };
};

const GH = 'https://api.github.com/repos/integry/propr';
const RAW_SUMMARY = 'https://raw.githubusercontent.com/integry/propr/v0.9.2/release-notes/v0.9.2.md';
const RELEASE = `${GH}/releases/tags/v0.9.2`;
const published = body => json({ tag_name: 'v0.9.2', draft: false, published_at: '2026-11-18T09:23:29Z', body });

describe('GitHub release target', () => {
  test('ok when published and the body starts with the summary at the tag', async () => {
    const { result } = await run(['github-release'], {
      [RELEASE]: published(`${SUMMARY.replace(/\n/g, '\r\n')}\n## What's Changed\n* PR`),
      [RAW_SUMMARY]: text(SUMMARY),
    });
    assert.equal(result.status, 'ok');
    assert.match(result.found, /release-notes\/v0\.9\.2\.md at v0\.9\.2/);
  });

  test('falls back to the local checkout summary when the tag has none', async () => {
    const { result } = await run(['github-release'], { [RELEASE]: published(SUMMARY) }, {
      repoRoot: '/repo',
      readFile: async path => {
        assert.equal(path, '/repo/release-notes/v0.9.2.md');
        return SUMMARY;
      },
    });
    assert.equal(result.status, 'ok');
    assert.match(result.found, /local checkout/);
  });

  test('does not fall back to the local summary when the tag read fails other than 404', async () => {
    const REVISED = '## Highlights\n\nRevised locally.\n';
    let localReads = 0;
    const { result } = await run(['github-release'], {
      [RELEASE]: published(`${REVISED}\n## What's Changed\n* PR`),
      [RAW_SUMMARY]: text('Service Unavailable', 503),
    }, {
      repoRoot: '/repo',
      readFile: async () => { localReads += 1; return REVISED; },
    });
    assert.equal(result.status, 'missing');
    assert.match(result.found, /release-notes\/v0\.9\.2\.md at v0\.9\.2 returned HTTP 503/);
    assert.equal(localReads, 0);
  });

  test('missing when there is no release, or no checked-in summary', async () => {
    assert.equal((await run(['github-release'], {})).result.status, 'missing');
    const { result } = await run(['github-release'], { [RELEASE]: published(SUMMARY) });
    assert.equal(result.status, 'missing');
    assert.match(result.found, /no checked-in summary/);
  });

  test('stale when the body is GitHub-generated only, or the release is a draft', async () => {
    const generated = await run(['github-release'], { [RELEASE]: published("## What's Changed\n* PR"), [RAW_SUMMARY]: text(SUMMARY) });
    assert.equal(generated.result.status, 'stale');
    assert.match(generated.result.found, /does not start with/);
    const draft = await run(['github-release'], { [RELEASE]: json({ draft: true }) });
    assert.equal(draft.result.status, 'stale');
  });

  test('reports a rate-limited API as missing with the reason', async () => {
    const { result } = await run(['github-release'], { [RELEASE]: json({ message: 'rate limit' }, 403) });
    assert.equal(result.status, 'missing');
    assert.match(result.found, /HTTP 403 \(GitHub API rate limit\?\)/);
  });
});

const HUB = 'https://hub.docker.com/v2/repositories/propr/app/tags';
describe('Docker Hub image targets', () => {
  test('one target per release image', () => {
    assert.deepEqual(TARGETS.filter(entry => entry.kind === 'docker-image').map(entry => entry.repository),
      ['propr/app', 'propr/ui', 'propr/docs', 'propr/agent']);
  });

  test('ok when the version tag exists and latest has the same digest', async () => {
    const { result } = await run(['docker:propr/app'], { [`${HUB}/0.9.2`]: json({ digest: DIGEST }), [`${HUB}/latest`]: json({ digest: DIGEST }) });
    assert.equal(result.status, 'ok');
    assert.equal(result.found, 'propr/app:0.9.2 sha256:aaaaaaaaaaaa… = latest');
  });

  test('missing without the version tag', async () => {
    const { result } = await run(['docker:propr/app'], { [`${HUB}/latest`]: json({ digest: OLD_DIGEST }) });
    assert.equal(result.status, 'missing');
    assert.equal(result.found, 'no propr/app:0.9.2 tag');
  });

  test('stale when latest points at another digest', async () => {
    const { result } = await run(['docker:propr/app'], { [`${HUB}/0.9.2`]: json({ digest: DIGEST }), [`${HUB}/latest`]: json({ digest: OLD_DIGEST }) });
    assert.equal(result.status, 'stale');
    assert.match(result.found, /latest is sha256:bbbbbbbbbbbb…/);
  });
});

const NPM = 'https://registry.npmjs.org';
describe('npm package target', () => {
  test('ok when latest is the version', async () => {
    const { result } = await run(['npm:propr-cli'], { [`${NPM}/-/package/propr-cli/dist-tags`]: json({ latest: '0.9.2' }) });
    assert.equal(result.status, 'ok');
  });

  test('missing when the version is not published', async () => {
    const { result } = await run(['npm:propr-cli'], { [`${NPM}/-/package/propr-cli/dist-tags`]: json({ latest: '0.9.1' }) });
    assert.equal(result.status, 'missing');
    assert.match(result.found, /not published; latest is 0\.9\.1/);
  });

  test('stale when the version is published but latest is another', async () => {
    const { result } = await run(['npm:propr-cli'], {
      [`${NPM}/-/package/propr-cli/dist-tags`]: json({ latest: '0.9.1' }),
      [`${NPM}/propr-cli/0.9.2`]: json({ version: '0.9.2' }),
    });
    assert.equal(result.status, 'stale');
  });
});

const APP = 'https://app.propr.dev/';
const INDEX = '<script type="module" crossorigin src="/assets/index-Abc123.js"></script>';
describe('hosted UI target', () => {
  test('ok when the entry bundle embeds the version, read without caches', async () => {
    const { result, requests } = await run(['hosted-ui'], { [APP]: text(INDEX), [`${APP}assets/index-Abc123.js`]: text('const v="0.9.2";') });
    assert.equal(result.status, 'ok');
    assert.equal(result.found, '/assets/index-Abc123.js contains "0.9.2"');
    assert.ok(requests.every(request => request.headers['cache-control'] === 'no-cache'));
  });

  test('stale when the bundle is the previous release', async () => {
    const { result } = await run(['hosted-ui'], { [APP]: text(INDEX), [`${APP}assets/index-Abc123.js`]: text('const v="0.9.1";') });
    assert.equal(result.status, 'stale');
  });

  test('missing when the page or its entry module is not served', async () => {
    assert.equal((await run(['hosted-ui'], { [APP]: text('down', 503) })).result.status, 'missing');
    const noEntry = await run(['hosted-ui'], { [APP]: text('<html></html>') });
    assert.equal(noEntry.result.status, 'missing');
    assert.match(noEntry.result.found, /does not load/);
  });
});

const DEMO = 'https://demo.propr.dev/api/status';
describe('demo status target', () => {
  test('ok, stale and missing', async () => {
    assert.equal((await run(['demo'], { [DEMO]: json({ version: '0.9.2', api: 'healthy' }) })).result.status, 'ok');
    const old = await run(['demo'], { [DEMO]: json({ version: '0.9.1' }) });
    assert.equal(old.result.status, 'stale');
    assert.equal(old.result.found, 'version "0.9.1"');
    const down = await run(['demo'], { [DEMO]: text('error code: 502', 502) });
    assert.equal(down.result.status, 'missing');
    assert.match(down.result.found, /HTTP 502/);
  });

  test('a network failure is missing, not a crash', async () => {
    const { result } = await run(['demo'], { [DEMO]: new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) });
    assert.equal(result.status, 'missing');
    assert.match(result.found, /fetch failed \(ENOTFOUND\)/);
  });
});

const RELEASES = `${GH}/releases?per_page=100&page=1`;
const asset = name => ({ name });
const linuxAssets = version => [`ProPR-Desktop-${version}-linux-x64.deb`, `ProPR-Desktop-${version}-linux-arm64.deb`,
  `ProPR-Desktop-${version}-linux-x64.rpm`, `ProPR-Desktop-${version}-linux-arm64.rpm`, 'linux-preview.json', 'SHA256SUMS', 'SHA256SUMS.asc', 'INSTALL.md'].map(asset);
const macosAssets = version => [`ProPR-Desktop-${version}-macos-arm64.dmg`, `ProPR-Desktop-${version}-macos-x64.dmg`,
  `ProPR-Desktop-${version}-macos-arm64.zip`, `ProPR-Desktop-${version}-macos-x64.zip`, 'macos-preview.json', 'SHA256SUMS'].map(asset);
const release = (tag, assets, extra = {}) => ({ tag_name: tag, draft: false, prerelease: true, assets, ...extra });

describe('desktop pre-release targets', () => {
  test('ok when signed Linux and macOS pre-releases carry every package; one list read serves both', async () => {
    const { results, requests } = await run(['desktop:linux', 'desktop:macos'], {
      [RELEASES]: json([
        release('desktop-macos-preview-v0.9.2-60792554ba3a', macosAssets('0.9.2')),
        release('desktop-linux-preview-v0.9.2-60792554ba3a-all-signed', linuxAssets('0.9.2')),
        release('desktop-linux-preview-v0.9.2-60792554ba3a', linuxAssets('0.9.2').slice(0, 4)),
      ]),
    });
    assert.deepEqual(results.map(result => result.status), ['ok', 'ok']);
    assert.match(results[0].found, /desktop-linux-preview-v0\.9\.2-60792554ba3a-all-signed with 7 expected files/);
    assert.equal(requests.filter(request => request.url.startsWith(`${GH}/releases?`)).length, 1);
  });

  test('missing when only an unsigned stage or an older version exists', async () => {
    const { results } = await run(['desktop:linux', 'desktop:macos'], {
      [RELEASES]: json([
        release('desktop-linux-preview-v0.9.2-60792554ba3a', linuxAssets('0.9.2')),
        release('desktop-linux-preview-v0.9.1-dcd3bb97dd3c-all-signed', linuxAssets('0.9.1')),
        release('desktop-macos-preview-v0.9.1-dcd3bb97dd3c', macosAssets('0.9.1')),
      ]),
    });
    assert.deepEqual(results.map(result => result.status), ['missing', 'missing']);
    assert.match(results[0].found, /newest is desktop-linux-preview-v0\.9\.1-dcd3bb97dd3c-all-signed/);
  });

  test('a release candidate of the version does not count as the stable release', async () => {
    const { results } = await run(['desktop:linux', 'desktop:macos'], {
      [RELEASES]: json([
        release('desktop-linux-preview-v0.9.2-rc.1-60792554ba3a-all-signed', linuxAssets('0.9.2')),
        release('desktop-macos-preview-v0.9.2-rc.1-60792554ba3a', macosAssets('0.9.2')),
      ]),
    });
    assert.deepEqual(results.map(result => result.status), ['missing', 'missing']);
  });

  test('a draft does not count', async () => {
    const { result } = await run(['desktop:macos'], {
      [RELEASES]: json([release('desktop-macos-preview-v0.9.2-60792554ba3a', macosAssets('0.9.2'), { draft: true })]),
    });
    assert.equal(result.status, 'missing');
  });

  test('stale when the pre-release lacks package files', async () => {
    const { result } = await run(['desktop:macos'], {
      [RELEASES]: json([release('desktop-macos-preview-v0.9.2-60792554ba3a', macosAssets('0.9.2').filter(entry => !entry.name.endsWith('.dmg')))]),
    });
    assert.equal(result.status, 'stale');
    assert.match(result.found, /lacks ProPR-Desktop-0\.9\.2-macos-arm64\.dmg, ProPR-Desktop-0\.9\.2-macos-x64\.dmg/);
  });

  test('pages through the release list', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => release(`v0.0.${index}`, []));
    const { result } = await run(['desktop:macos'], {
      [RELEASES]: json(filler),
      [`${GH}/releases?per_page=100&page=2`]: json([release('desktop-macos-preview-v0.9.2-60792554ba3a', macosAssets('0.9.2'))]),
    });
    assert.equal(result.status, 'ok');
  });
});

const WHATS_NEW = 'https://propr.dev/whats-new/0.9.2/';
const DOWNLOAD = 'https://propr.dev/desktop/';
const downloadPage = version => `
  <a href="https://github.com/integry/propr/releases/download/desktop-linux-preview-v${version}-dcd3bb97dd3c-all-signed/ProPR-Desktop-${version}-linux-x64.deb">deb</a>
  <a href="https://github.com/integry/propr/releases/download/desktop-macos-preview-v${version}-dcd3bb97dd3c/ProPR-Desktop-${version}-macos-arm64.dmg">dmg</a>`;

describe('site targets', () => {
  test("what's new page: ok on 200, missing on 404", async () => {
    assert.equal((await run(['site:whats-new'], { [WHATS_NEW]: text('<h1>0.9.2</h1>') })).result.status, 'ok');
    const absent = await run(['site:whats-new'], {});
    assert.equal(absent.result.status, 'missing');
    assert.equal(absent.result.found, `${WHATS_NEW} HTTP 404`);
  });

  test('download page: ok when it links both desktop pre-releases of the version', async () => {
    const { result } = await run(['site:download'], { [DOWNLOAD]: text(downloadPage('0.9.2')) });
    assert.equal(result.status, 'ok');
  });

  test('download page: stale while it links release-candidate builds of the version', async () => {
    const page = `
  <a href="https://github.com/integry/propr/releases/download/desktop-linux-preview-v0.9.2-rc.1-60792554ba3a-all-signed/ProPR-Desktop-0.9.2-rc.1-linux-x64.deb">deb</a>
  <a href="https://github.com/integry/propr/releases/download/desktop-macos-preview-v0.9.2-rc.1-60792554ba3a/ProPR-Desktop-0.9.2-rc.1-macos-arm64.dmg">dmg</a>`;
    const { result } = await run(['site:download'], { [DOWNLOAD]: text(page) });
    assert.equal(result.status, 'stale');
    assert.match(result.found, /links desktop-linux-preview-v0\.9\.2-rc\.1-60792554ba3a-all-signed, not desktop-linux-preview-v0\.9\.2-\*-all-signed/);
    assert.match(result.found, /links desktop-macos-preview-v0\.9\.2-rc\.1-60792554ba3a, not desktop-macos-preview-v0\.9\.2-\*/);
  });

  test('download page: stale while it links the previous release, missing when down', async () => {
    const old = await run(['site:download'], { [DOWNLOAD]: text(downloadPage('0.9.1')) });
    assert.equal(old.result.status, 'stale');
    assert.match(old.result.found, /links desktop-linux-preview-v0\.9\.1-dcd3bb97dd3c-all-signed, not desktop-linux-preview-v0\.9\.2-\*-all-signed/);
    const unsignedOnly = await run(['site:download'], {
      [DOWNLOAD]: text(downloadPage('0.9.2').replace('-all-signed', '')),
    });
    assert.equal(unsignedOnly.result.status, 'stale');
    assert.equal((await run(['site:download'], { [DOWNLOAD]: text('', 500) })).result.status, 'missing');
  });
});

const everythingLive = () => {
  const routes = {
    [RELEASE]: published(`${SUMMARY}\n## What's Changed`),
    [RAW_SUMMARY]: text(SUMMARY),
    [`${NPM}/-/package/propr-cli/dist-tags`]: json({ latest: VERSION }),
    [APP]: text(INDEX),
    [`${APP}assets/index-Abc123.js`]: text('"0.9.2"'),
    [DEMO]: json({ version: VERSION }),
    [RELEASES]: json([
      release('desktop-linux-preview-v0.9.2-60792554ba3a-all-signed', linuxAssets(VERSION)),
      release('desktop-macos-preview-v0.9.2-60792554ba3a', macosAssets(VERSION)),
    ]),
    [WHATS_NEW]: text('ok'),
    [DOWNLOAD]: text(downloadPage(VERSION)),
  };
  for (const repository of ['app', 'ui', 'docs', 'agent']) {
    for (const tag of [VERSION, 'latest']) routes[`https://hub.docker.com/v2/repositories/propr/${repository}/tags/${tag}`] = json({ digest: DIGEST });
  }
  return routes;
};

const cli = async (argv, routes, env = {}) => {
  const out = [];
  const err = [];
  const summaries = [];
  const { fetchImpl, requests } = mockFetch(routes);
  const code = await main({
    argv, env, fetchImpl, repoRoot: '/nonexistent',
    stdout: line => out.push(line), stderr: line => err.push(line),
    appendSummary: (file, content) => summaries.push({ file, content }),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), summaries, requests };
};

describe('verify-release-rollout CLI', () => {
  test('the target table covers every release destination with known kinds and unique ids', () => {
    const ids = TARGETS.map(entry => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ['github-release', 'docker:propr/app', 'docker:propr/ui', 'docker:propr/docs', 'docker:propr/agent',
      'npm:propr-cli', 'hosted-ui', 'demo', 'desktop:linux', 'desktop:macos', 'site:whats-new', 'site:download']);
  });

  test('exits 0 with one ok line per target when everything is live, without credentials', async () => {
    const { code, out, requests } = await cli(['--version', VERSION], everythingLive(), { GITHUB_TOKEN: 'should-not-be-sent' });
    assert.equal(code, 0);
    const lines = out.split('\n');
    assert.equal(lines.length, TARGETS.length);
    assert.ok(lines.every(line => line.startsWith('ok ')), out);
    for (const request of requests) {
      assert.equal(Object.keys(request.headers).some(name => name.toLowerCase() === 'authorization'), false);
      assert.ok(request.url.startsWith('https://'), request.url);
    }
  });

  test('exits 1 when any target is not ok; --json prints the same results', async () => {
    const routes = everythingLive();
    routes[DEMO] = json({ version: '0.9.1' });
    const { code, out } = await cli(['--version', 'v0.9.2', '--json'], routes);
    assert.equal(code, 1);
    const report = JSON.parse(out);
    assert.equal(report.version, VERSION);
    assert.equal(report.ok, false);
    assert.deepEqual(report.targets.find(entry => entry.id === 'demo'), { id: 'demo', kind: 'status-json', status: 'stale', found: 'version "0.9.1"' });
    assert.equal(report.targets.filter(entry => entry.status === 'ok').length, TARGETS.length - 1);
  });

  test('writes a table to the GitHub Actions run summary', async () => {
    const routes = everythingLive();
    delete routes[WHATS_NEW];
    const { summaries } = await cli(['--version', VERSION], routes, { GITHUB_STEP_SUMMARY: '/tmp/summary.md' });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].file, '/tmp/summary.md');
    assert.match(summaries[0].content, /### Release rollout of ProPR 0\.9\.2/);
    assert.match(summaries[0].content, /11 of 12 targets serve 0\.9\.2/);
    assert.match(summaries[0].content, /\| `site:whats-new` \| ❌ missing \| https:\/\/propr\.dev\/whats-new\/0\.9\.2\/ HTTP 404 \|/);
  });

  test('rejects a missing or malformed version with exit 2', async () => {
    for (const argv of [[], ['--version'], ['--version', '0.9'], ['--version', '0.9.2', '--bogus']]) {
      const { code, err } = await cli(argv, {});
      assert.equal(code, 2, JSON.stringify(argv));
      assert.match(err, /Usage:/);
    }
    assert.equal(parseArgs(['--version=1.2.3-rc.1']).version, '1.2.3-rc.1');
  });

  test('formats aligned text lines and escapes summary cells', () => {
    const results = [{ id: 'a', status: 'ok', found: 'x' }, { id: 'longer', status: 'missing', found: 'y | z' }];
    assert.equal(formatText(results), 'ok       a       x\nmissing  longer  y | z');
    assert.match(formatSummary('1.0.0', results), /y \\\| z/);
    const backslash = formatSummary('1.0.0', [{ id: 'b', status: 'stale', found: 'C:\\dir\\| x' }]);
    assert.ok(backslash.includes('| C:\\\\dir\\\\\\| x |'), backslash);
  });

  test('npm run release:rollout runs this script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.equal(pkg.scripts['release:rollout'], 'node scripts/verify-release-rollout.mjs');
  });
});
