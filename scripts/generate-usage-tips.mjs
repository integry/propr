import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// IDs are editorial identities, never derived from wording or content hashes.
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
const clean = text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
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
  catalog.push({ id: spec.id, kind, topic: spec.topic, title: spec.title, body, docPath: spec.docPath, docUrl: `https://docs.propr.dev/${publicPath}`, signalHints: spec.signalHints });
}
// Stable sort preserves the existing corrective identities and editorial order.
catalog.sort((a, b) => Number(a.kind === 'discovery') - Number(b.kind === 'discovery'));
const ids = new Set();
for (const tip of catalog) {
  if (!/^[a-z][a-z0-9-]+$/.test(tip.id) || ids.has(tip.id)) throw new Error(`Invalid/duplicate ID ${tip.id}`);
  ids.add(tip.id);
  if (new URL(tip.docUrl).origin !== 'https://docs.propr.dev' || !tip.title || !tip.topic || !tip.signalHints.length) throw new Error('Invalid generated fields');
}
for (const topic of ['review','fix','switch','use','ultrafix','merge','goals','plans','todos','indexing','routing','tank','inbox','mcp']) {
  if (!catalog.some(t => t.topic === topic)) throw new Error(`Missing coverage: ${topic}`);
}
const target = path.join(root, 'packages/shared/src/usageTips.catalog.json');
await writeFile(`${target}.tmp`, JSON.stringify(catalog, null, 2) + '\n');
await rename(`${target}.tmp`, target);
console.log(`Generated ${catalog.length} documentation tips`);
