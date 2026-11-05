import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DOCS_ORIGIN = 'https://docs.propr.dev';
// The classic docs plugin serves docs/docs/** under its default /docs route base.
export const DOCS_ROUTE_BASE = '/docs/';
// IDs are editorial identities, never derived from wording or content hashes.
// publicPath overrides the route (relative to DOCS_ROUTE_BASE) when docPath is not a published docs page.
const specs = [
  ...['review', 'fix', 'switch', 'use', 'ultrafix', 'merge'].map(command => ({
    id: `pr-${command}`, topic: command, title: `Try /${command}`, docPath: 'docs/docs/features/pr-commands.md',
    anchor: command, signalHints: [command, 'tasks'], command,
  })),
  { id: 'goals-launch', topic: 'goals', title: 'Choose how to launch a goal', docPath: 'docs/docs/features/usage-tips.md', match: /^Goals support/, anchor: 'goals-and-launch-strategies', signalHints: ['goals', 'oneOffTasks'] },
  { id: 'planner-studio', topic: 'plans', title: 'Plan before implementation', docPath: 'docs/docs/features/planning.md', match: /Planner Studio .*/, signalHints: ['plans', 'oneOffTasks'] },
  { id: 'repository-todos', topic: 'todos', title: 'Keep repository to-dos', docPath: 'docs/docs/features/repository-knowledge.md', match: /The To-Dos tab .*/, anchor: 'repository-todos', signalHints: ['todos', 'tasks'] },
  { id: 'indexing-options', topic: 'indexing', title: 'Tune repository indexing', docPath: 'docs/docs/features/repository-knowledge.md', match: /Summarization runs .*/, anchor: 'indexing-and-summaries', signalHints: ['indexingFailures', 'indexingSlow'] },
  { id: 'agent-model-selection', topic: 'routing', title: 'Choose agents and models per phase', docPath: 'docs/docs/features/agents-and-models.md', match: /ProPR .*/, signalHints: ['distinctAgents', 'distinctModels'] },
  { id: 'agent-tank', topic: 'tank', title: 'Monitor provider usage with Agent Tank', docPath: 'docs/docs/operations/agent-tank.md', match: /Agent Tank .*/, signalHints: ['tankEnabled', 'tankRecords'] },
  { id: 'notification-inbox', topic: 'inbox', title: 'Keep track of work in your inbox', docPath: 'docs/docs/operations/pwa-web-push.md', match: /^The Show an unread-count badge/, anchor: 'badges-are-progressive-enhancement', signalHints: ['inboxActions', 'notifications'] },
  { id: 'mcp-access', topic: 'mcp', title: 'Connect tools through MCP', docPath: 'docs/mcp.md', match: /^This is the flow the operator surface/, firstSentence: true, publicPath: 'features/web-ui#mcp-access-log', signalHints: ['mcpEnabled', 'mcpGrants'] },
  { id: 'mcp-chat-control', kind: 'discovery', topic: 'mcp', title: 'Run ProPR from your chat assistant', docPath: 'docs/docs/features/mcp-chat.md', match: /^Connect a chat assistant/, signalHints: ['mcpUsage', 'tasks'] },
  { id: 'visual-previews', kind: 'discovery', topic: 'previews', title: 'See visual previews on pull requests', docPath: 'docs/docs/features/visual-previews.md', match: /^Visual previews let/, firstSentence: true, signalHints: ['visualPreviewRepos', 'tasks'] },
  { id: 'repository-chat', kind: 'discovery', topic: 'chat', title: 'Ask questions about your repository', docPath: 'docs/docs/features/repository-knowledge.md', match: /^The Chat tab/, anchor: 'repository-chat', firstSentence: true, signalHints: ['repoChatMessages', 'tasks'] },
  { id: 'epic-auto-merge', kind: 'discovery', topic: 'epic', title: 'Run a plan with Epic mode', docPath: 'docs/docs/features/planning.md', match: /^- Enable Epic mode/, line: true, anchor: 'running-from-a-plan', signalHints: ['epicPlans', 'plans'] },
];
export const clean = text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
/** Heading IDs as Docusaurus renders them (github-slugger, explicit `{#id}`, duplicate suffixes). */
export function headingAnchors(markdown) {
  const anchors = new Set();
  let fence = null;
  for (const line of markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) fence = fence === marker ? null : fence ?? marker;
    const heading = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const explicit = heading.match(/\{#([^}\s]+)\}\s*$/);
    if (explicit) { anchors.add(explicit[1]); continue; }
    const base = clean(heading).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let id = base;
    for (let n = 1; anchors.has(id); n++) id = `${base}-${n}`;
    anchors.add(id);
  }
  return anchors;
}

/** Maps a public docs URL back to its Docusaurus source page and checks the page and fragment exist. */
export function verifyDocTarget(docUrl, docsRoot = path.join(root, 'docs/docs')) {
  const url = new URL(docUrl);
  if (url.origin !== DOCS_ORIGIN || !url.pathname.startsWith(DOCS_ROUTE_BASE) || url.search) throw new Error(`Not a docs route: ${docUrl}`);
  const page = url.pathname.slice(DOCS_ROUTE_BASE.length);
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(page)) throw new Error(`Invalid docs page: ${docUrl}`);
  const file = ['.md', '.mdx'].map(ext => path.join(docsRoot, page + ext)).find(existsSync);
  if (!file) throw new Error(`Missing docs page for ${docUrl}`);
  const markdown = readFileSync(file, 'utf8');
  if (/^(slug|id):/m.test(markdown.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '')) throw new Error(`Docs page overrides its route: ${file}`);
  const anchor = decodeURIComponent(url.hash.slice(1));
  if (anchor && !headingAnchors(markdown).has(anchor)) throw new Error(`Missing heading #${anchor} in ${file}`);
}

/** Checks a built Docusaurus site serves each docs URL and renders its fragment ID. */
export function verifyBuiltDocTarget(docUrl, siteDir) {
  const url = new URL(docUrl);
  const file = path.join(siteDir, url.pathname, 'index.html');
  if (!existsSync(file)) throw new Error(`Built site has no route ${url.pathname}`);
  const anchor = decodeURIComponent(url.hash.slice(1));
  // Minified Docusaurus HTML leaves simple attribute values unquoted.
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (anchor && !new RegExp(`\\sid=(?:"${escaped}"|${escaped}(?=[\\s>]))`).test(readFileSync(file, 'utf8'))) {
    throw new Error(`Built ${url.pathname} has no #${anchor}`);
  }
  const sitemap = path.join(siteDir, 'sitemap.xml');
  if (existsSync(sitemap) && !readFileSync(sitemap, 'utf8').includes(`<loc>${url.origin}${url.pathname}</loc>`)) {
    throw new Error(`Built sitemap omits ${url.pathname}`);
  }
}

export async function generateUsageTips() {
  const config = await readFile(path.join(root, 'docs/docusaurus.config.ts'), 'utf8');
  if (!config.includes(`url: '${DOCS_ORIGIN}'`) || !/\bbaseUrl: '\/'/.test(config) || /\brouteBasePath\s*:/.test(config)) {
    throw new Error('Docs site URL, baseUrl or docs routeBasePath changed; update DOCS_ORIGIN/DOCS_ROUTE_BASE');
  }
  const catalog = [];
  for (const spec of specs) {
    if (!/^docs\/docs\/.+\.md$/.test(spec.docPath) && spec.docPath !== 'docs/mcp.md') throw new Error('Invalid source path');
    const source = await readFile(path.join(root, spec.docPath), 'utf8');
    let body;
    if (spec.command) {
      const row = source.split('\n').find(line => line.startsWith(`| \`/${spec.command}`));
      if (!row) throw new Error(`Missing command documentation: ${spec.command}`);
      body = `Use /${spec.command} when ${clean(row.split('|')[2]).replace(/^You /, 'you ')}.`;
    } else {
      const paragraphs = source.replace(/^---\n[\s\S]*?\n---\n/, '').split(spec.line ? '\n' : /\n\s*\n/).map(clean);
      body = paragraphs.find(p => !p.startsWith('#') && spec.match.test(p));
    }
    if (!body || body.length < 25) throw new Error(`Missing documentation for ${spec.id}`);
    if (spec.line) body = body.replace(/^- /, '');
    if (spec.firstSentence) body = body.split('. ')[0] + '.';
    if (body.length > 420) body = body.slice(0, 417).replace(/\s+\S*$/, '') + '…';
    const publicPath = spec.publicPath ?? spec.docPath.replace(/^docs\/docs\//, '').replace(/\.md$/, '') + (spec.anchor ? `#${spec.anchor}` : '');
    const kind = spec.kind ?? 'corrective';
    if (kind === 'discovery' && body.length > 240) throw new Error(`Discovery body too long: ${spec.id}`);
    if (!['corrective', 'discovery'].includes(kind)) throw new Error(`Invalid kind for ${spec.id}`);
    catalog.push({ id: spec.id, kind, topic: spec.topic, title: spec.title, body, docPath: spec.docPath, docUrl: `${DOCS_ORIGIN}${DOCS_ROUTE_BASE}${publicPath}`, signalHints: spec.signalHints });
  }
  // Stable sort preserves the existing corrective identities and editorial order.
  catalog.sort((a, b) => Number(a.kind === 'discovery') - Number(b.kind === 'discovery'));
  const ids = new Set();
  for (const tip of catalog) {
    if (!/^[a-z][a-z0-9-]+$/.test(tip.id) || ids.has(tip.id)) throw new Error(`Invalid/duplicate ID ${tip.id}`);
    ids.add(tip.id);
    if (!tip.title || !tip.topic || !tip.signalHints.length) throw new Error('Invalid generated fields');
    verifyDocTarget(tip.docUrl);
  }
  for (const topic of ['review','fix','switch','use','ultrafix','merge','goals','plans','todos','indexing','routing','tank','inbox','mcp']) {
    if (!catalog.some(t => t.topic === topic)) throw new Error(`Missing coverage: ${topic}`);
  }
  return catalog;
}

export const CATALOG_PATH = path.join(root, 'packages/shared/src/usageTips.catalog.json');

async function main(args) {
  const catalog = await generateUsageTips();
  const siteIndex = args.indexOf('--site');
  if (siteIndex !== -1) {
    if (!args[siteIndex + 1]) throw new Error('--site needs a built docs directory');
    for (const tip of catalog) verifyBuiltDocTarget(tip.docUrl, path.resolve(args[siteIndex + 1]));
    console.log(`Verified ${catalog.length} documentation links against ${args[siteIndex + 1]}`);
  }
  const output = JSON.stringify(catalog, null, 2) + '\n';
  if (args.includes('--check')) {
    if (await readFile(CATALOG_PATH, 'utf8') !== output) {
      console.error('usageTips.catalog.json is out of date; run npm run tips:generate');
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(`${CATALOG_PATH}.tmp`, output);
  await rename(`${CATALOG_PATH}.tmp`, CATALOG_PATH);
  console.log(`Generated ${catalog.length} documentation tips`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
