// Serves a production Docusaurus build with the exact static-server command from
// docs/Dockerfile and probes it over HTTP: article routes must return their own
// HTML (not the SPA homepage), unknown paths must 404, and sitemap/assets must work.
//
// Usage: node scripts/check-docs-static-serving.mjs <build-dir> [--serve-bin <path>]
// Without --serve-bin the pinned serve version is run through npx.
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATALOG_PATH, DOCS_ORIGIN } from './generate-usage-tips.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DOCKERFILE_PATH = path.join(root, 'docs/Dockerfile');
export const SERVE_CONFIG_PATH = path.join(root, 'docs/serve.json');
// Representative targets that must be probed even if the catalog changes.
export const REQUIRED_ROUTES = ['/docs/features/planning', '/docs/features/planning#running-from-a-plan',
  '/docs/features/usage-tips#goals-and-launch-strategies'];

/** Extracts the pinned serve version and the runtime CMD from the docs Dockerfile. */
export function parseDocsServeCommand(dockerfile) {
  const version = dockerfile.match(/npm install -g serve@(\d+\.\d+\.\d+)\b/)?.[1];
  if (!version) throw new Error('docs/Dockerfile must install an exact serve@x.y.z version');
  const cmd = dockerfile.match(/^CMD\s+(\[.*\])\s*$/m)?.[1];
  if (!cmd) throw new Error('docs/Dockerfile has no exec-form CMD');
  const args = JSON.parse(cmd);
  if (args[0] !== 'serve') throw new Error(`docs/Dockerfile CMD must run serve, got ${args[0]}`);
  if (args.some(arg => arg === '-s' || arg === '--single')) {
    throw new Error('docs/Dockerfile serves in single-page mode; every route would answer with the homepage');
  }
  const listen = args.findIndex(arg => arg === '-l' || arg === '--listen');
  if (listen === -1) throw new Error('docs/Dockerfile CMD has no --listen address');
  return { version, args: args.slice(1), listen: listen - 1 };
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|([^\\s>]+))`))?.slice(1).find(Boolean);

/** Reads the document title, canonical URL and element IDs from (minified) Docusaurus HTML. */
export function describeHtml(html) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1];
  const canonicalTag = html.match(/<link\s[^>]*\brel=(?:"canonical"|canonical)[^>]*>/)?.[0];
  const ids = new Set([...html.matchAll(/<[a-zA-Z][^>]*?\sid=(?:"([^"]*)"|([^\s>]+))/g)].map(m => m[1] ?? m[2]));
  return { title, canonical: canonicalTag && attr(canonicalTag, 'href'), ids };
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Mirrors the image layout (/app/build + /app/serve.json) and starts the Dockerfile CMD in it. */
async function startServer(buildDir, serveBin) {
  const { version, args, listen } = parseDocsServeCommand(await readFile(DOCKERFILE_PATH, 'utf8'));
  const app = await mkdtemp(path.join(tmpdir(), 'propr-docs-serve-'));
  await symlink(path.resolve(buildDir), path.join(app, 'build'), 'dir');
  await copyFile(SERVE_CONFIG_PATH, path.join(app, 'serve.json'));
  const port = await freePort();
  const runArgs = args.map((arg, i) => (i === listen + 1 ? `tcp://127.0.0.1:${port}` : arg));
  const [command, prefix] = serveBin ? [serveBin, []] : ['npx', ['--yes', `serve@${version}`]];
  // Own process group, so stopping npx also stops the serve process it spawned.
  const child = spawn(command, [...prefix, ...runArgs], { cwd: app, detached: true,
    env: { ...process.env, NO_UPDATE_CHECK: '1' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
      await exited;
    }
    await rm(app, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    try {
      await fetch(base, { redirect: 'manual' });
      return { base, stop, command: [command, ...prefix, ...runArgs].join(' ') };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  await stop();
  throw new Error(`Static server did not start:\n${output}`);
}

async function get(base, pathname) {
  const response = await fetch(new URL(pathname, base), { redirect: 'manual' });
  return { status: response.status, type: response.headers.get('content-type') ?? '',
    body: Buffer.from(await response.arrayBuffer()) };
}

/** Runs every probe and returns a list of human-readable results; throws on the first failure. */
export async function checkDocsStaticServing(buildDir, { serveBin } = {}) {
  const site = path.resolve(buildDir);
  for (const file of ['index.html', '404.html', 'sitemap.xml']) {
    if (!existsSync(path.join(site, file))) throw new Error(`${site} is not a Docusaurus production build (no ${file})`);
  }
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  const targets = [...new Set([...REQUIRED_ROUTES.map(route => `${DOCS_ORIGIN}${route}`), ...catalog.map(tip => tip.docUrl)])];
  const homeHtml = readFileSync(path.join(site, 'index.html'));
  const home = describeHtml(homeHtml.toString());
  const sitemap = readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
  const server = await startServer(site, serveBin);
  const results = [`server: ${server.command}`];
  const fail = message => { throw new Error(message); };
  try {
    const homeResponse = await get(server.base, '/');
    if (homeResponse.status !== 200 || !homeResponse.body.equals(homeHtml)) fail(`/ returned ${homeResponse.status}, not build/index.html`);
    results.push(`/ -> 200 homepage "${home.title}"`);

    const asset = homeHtml.toString().match(/(?:src|href)="?(\/assets\/js\/[^"\s>]+\.js)/)?.[1] ?? fail('Homepage references no JS asset');
    const assetResponse = await get(server.base, asset);
    if (assetResponse.status !== 200 || !/javascript/.test(assetResponse.type)
      || !assetResponse.body.equals(readFileSync(path.join(site, asset)))) {
      fail(`${asset} returned ${assetResponse.status} ${assetResponse.type}`);
    }
    results.push(`${asset} -> 200 ${assetResponse.type}`);

    const sitemapResponse = await get(server.base, '/sitemap.xml');
    const sitemapBody = sitemapResponse.body.toString();
    if (sitemapResponse.status !== 200 || !/xml/.test(sitemapResponse.type) || !sitemapBody.startsWith('<?xml')
      || !sitemapBody.includes('<urlset') || sitemapBody !== sitemap) {
      fail(`/sitemap.xml returned ${sitemapResponse.status} ${sitemapResponse.type}, not the built XML sitemap`);
    }
    results.push(`/sitemap.xml -> 200 ${sitemapResponse.type}`);

    for (const target of targets) {
      const url = new URL(target);
      const anchor = decodeURIComponent(url.hash.slice(1));
      const article = readFileSync(path.join(site, url.pathname, 'index.html'));
      const expected = describeHtml(article.toString());
      if (!sitemap.includes(`<loc>${url.origin}${url.pathname}</loc>`)) fail(`sitemap.xml omits ${url.pathname}`);
      for (const pathname of [url.pathname, `${url.pathname}/`]) {
        const response = await get(server.base, pathname);
        const page = describeHtml(response.body.toString());
        if (response.status !== 200) fail(`${pathname} returned ${response.status}`);
        if (response.body.equals(homeHtml) || page.title === home.title) fail(`${pathname} returned the homepage`);
        if (!response.body.equals(article)) fail(`${pathname} did not return build${url.pathname}/index.html`);
        if (page.canonical !== `${url.origin}${url.pathname}`) fail(`${pathname} canonical is ${page.canonical}`);
        if (anchor && !page.ids.has(anchor)) fail(`${pathname} has no #${anchor}`);
      }
      results.push(`${url.pathname}${url.hash} -> 200 "${expected.title}" canonical ${expected.canonical}`);
    }

    const notFound = readFileSync(path.join(site, '404.html'));
    for (const pathname of ['/docs/features/no-such-page-propr-check', '/features/planning']) {
      const response = await get(server.base, pathname);
      if (response.status !== 404 || response.body.equals(homeHtml) || !response.body.equals(notFound)) {
        fail(`${pathname} returned ${response.status}${response.body.equals(homeHtml) ? ' with the homepage' : ''}, not build/404.html`);
      }
      results.push(`${pathname} -> 404 "${describeHtml(notFound.toString()).title}"`);
    }
  } finally {
    await server.stop();
  }
  return { results, targets };
}

async function main(args) {
  const binIndex = args.indexOf('--serve-bin');
  const serveBin = binIndex === -1 ? undefined : args[binIndex + 1];
  const buildDir = args.find((arg, i) => !arg.startsWith('--') && (binIndex === -1 || i !== binIndex + 1));
  if (!buildDir) throw new Error('Usage: check-docs-static-serving.mjs <build-dir> [--serve-bin <path>]');
  const { results, targets } = await checkDocsStaticServing(buildDir, { serveBin });
  for (const line of results) console.log(line);
  console.log(`Verified ${targets.length} documentation routes served from ${buildDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
