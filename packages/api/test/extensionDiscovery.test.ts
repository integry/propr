import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import knex from 'knex';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';
import { ExtensionProfileStore } from '../../core/src/extensions/extensionProfileStore.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';

type ProbeResponse = Readable & { statusCode: number; headers: Record<string, string> };
type ProbeOptions = { headers: Record<string, string | undefined>; agent: boolean; servername?: string };

const repositoryChecks: string[] = [];
const gitRequests: Array<{ route: string; params: Record<string, string | number> }> = [];
let beforeGitReply = async () => {};
const sha = 'a'.repeat(40);
await mock.module('../githubMetadataAuth.js', { namedExports: {
  resolveGitHubMetadataToken: async () => 'synthetic',
  verifyGitHubRepositoryAccess: async (repository: string) => { repositoryChecks.push(repository); },
} });
const { closeConnection } = await import('@propr/core');
await mock.module('@octokit/core', { namedExports: { Octokit: class {
  async request(route: string, params: Record<string, string | number>) {
    gitRequests.push({ route, params }); await beforeGitReply();
    if (route.endsWith('/git/commits/{commit_sha}')) return { data: { sha: params.commit_sha, tree: { sha: 'c'.repeat(40) } } };
    if (route.endsWith('/git/trees/{tree_sha}')) return { data: { truncated: false, tree: [{ path: 'skills/test/SKILL.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 100 }] } };
    if (route.endsWith('/git/blobs/{file_sha}')) return { data: { encoding: 'base64', content: Buffer.from('---\nname: pinned-test\ndescription: Pinned skill fixture\n---\nReview documentation.').toString('base64') } };
    return { data: route.endsWith('/branches') ? [{ name: 'main' }] : route.endsWith('/tags') ? [{ name: 'v1' }] : { sha } };
  }
} } });
const { createExtensionProfileRoutes } = await import('../routes/extensionProfileRoutes.js');
const { requestExtensionMcp } = await import('../../core/src/extensions/endpointPolicy.js');
after(closeConnection);

test('admin discovery is secret-free and bounded; Git refs resolve separately from immutable import', async t => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id'); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' }); await up(database);
  const store = new ExtensionProfileStore(database); const routes = createExtensionProfileRoutes(store);
  const app = express();
  // Match production: bound requests before parsing and authorization.
  app.use(createApiRequestRateLimiter({ PROPR_API_RATE_LIMIT_MAX: '15' }));
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-test-actor')) req.user = { id: req.get('x-test-actor')! } as typeof req.user;
    req.authorization = { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }; next();
  });
  app.post('/tools', routes.discoverTools); app.post('/source', routes.githubSource); app.post('/import', routes.importGithub);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const post = (path: string, body: unknown, h = headers) => fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  for (const route of ['/tools', '/source']) {
    assert.equal((await post(route, {}, { ...headers, 'x-test-actor': '' })).status, 401);
    assert.equal((await post(route, {}, { ...headers, 'x-propr-extensions': '' })).status, 403);
  }
  let tools: unknown[] = [{ name: 'lookup', description: 'PRIVATE_DESCRIPTION', inputSchema: { secret: 'PRIVATE_SCHEMA' } }, { name: 'bad name' }, { name: 'lookup' }, { name: 123 }, { name: 'update-docs' }];
  let calls = 0; let beforeProbeReply = async () => {};
  t.mock.method(https, 'request', (url: URL, options: ProbeOptions, callback: (response: ProbeResponse) => void) => {
    assert.equal(url.href, 'https://8.8.8.8/mcp');
    assert.equal(options.headers.Host, '8.8.8.8');
    calls++; assert.equal(options.headers.Authorization, undefined); assert.equal(options.agent, false);
    const request = Object.assign(new EventEmitter(), { end: async (payload: string) => {
      assert.deepEqual(JSON.parse(payload), {jsonrpc:'2.0',id:1,method:'tools/list'}); await beforeProbeReply();
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools}}))]), {statusCode:200,headers:{'content-type':'application/json'}});
      callback(response); response.on('end', () => request.emit('close'));
    }, destroy: () => request.emit('close') }); return request;
  });
  const discovered = await post('/tools', {url:'https://8.8.8.8/mcp'});
  assert.equal(discovered.status, 200); assert.deepEqual(await discovered.json(), {tools:['lookup','update-docs']});
  assert.equal((await post('/tools', {url:'https://8.8.8.8/mcp', token:'unaccepted'})).status,400);
  assert.equal((await post('/tools', {url:'https://127.0.0.1/mcp'})).status,502); assert.equal(calls,1);
  tools = Array.from({length:65}, () => ({name:'lookup'})); assert.equal((await post('/tools', {url:'https://8.8.8.8/mcp'})).status,502);
  tools = [{name:'lookup'}];
  beforeProbeReply = async () => { await database('instance_members').update({role:'member'}); };
  assert.equal((await post('/tools', {url:'https://8.8.8.8/mcp'})).status,403);
  await database('instance_members').update({role:'admin'});
  const refs = await post('/source', {repository:'team/repo'});
  assert.deepEqual(await refs.json(), {refs:[{name:'main',ref:'refs/heads/main',kind:'branch'},{name:'v1',ref:'refs/tags/v1',kind:'tag'}]});
  for (const ref of ['refs/heads/main','refs/tags/v1']) {
    const result = await post('/source', {repository:'team/repo',ref}); assert.deepEqual(await result.json(), {commit:sha});
    assert.equal(gitRequests.at(-1)!.params.ref, ref);
  }
  assert.deepEqual(repositoryChecks, ['team/repo','team/repo','team/repo']);
  const before = gitRequests.length;
  assert.equal((await post('/import', {repository:'team/repo',commit:'main',directory:'skills/test'})).status,400); assert.equal(gitRequests.length,before);
  const pinnedImport = await post('/import', { repository: 'team/repo', commit: sha, directory: 'skills/test' });
  assert.equal(pinnedImport.status, 200);
  assert.deepEqual((await pinnedImport.json()).bundle.source, { kind: 'github', repository: 'team/repo', commit: sha, directory: 'skills/test' });
  assert.equal(gitRequests.find(r => r.route.endsWith('/git/commits/{commit_sha}'))!.params.commit_sha, sha);
  beforeGitReply = async () => { await database('instance_members').update({role:'member'}); };
  assert.equal((await post('/source', {repository:'team/repo',ref:'refs/heads/main'})).status,403);
  const requestsBeforeLimit = { git: gitRequests.length, mcp: calls };
  for (const route of ['/tools', '/source', '/import']) {
    assert.equal((await post(route, {})).status, 429);
  }
  assert.equal(gitRequests.length, requestsBeforeLimit.git);
  assert.equal(calls, requestsBeforeLimit.mcp);
});

test('MCP transport dials vetted addresses while retaining endpoint Host, TLS identity and path', async t => {
  let addresses = [{ address: '8.8.8.8', family: 4 }];
  let calls = 0;
  let expectedHost = 'tools.example.com';
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', (url: URL, options: ProbeOptions, callback: (response: ProbeResponse) => void) => {
    calls++;
    assert.equal(url.hostname, addresses[0].family === 6 ? `[${addresses[0].address}]` : addresses[0].address);
    assert.equal(url.pathname, '/mcp%2Ftools');
    assert.equal(options.headers.Host, expectedHost);
    assert.equal(options.servername, expectedHost);
    assert.equal(options.agent, false);
    const request = Object.assign(new EventEmitter(), { end: () => {
      const response = Object.assign(Readable.from([Buffer.from('{}')]), { statusCode: 200, headers: { 'content-type': 'application/json' } });
      callback(response); response.on('end', () => request.emit('close'));
    }, destroy: () => request.emit('close') });
    return request;
  });
  const endpoint = 'https://tools.example.com/mcp%2Ftools';
  assert.deepEqual(await requestExtensionMcp(endpoint, {}), {});
  addresses = [{ address: '2606:4700:4700::1111', family: 6 }];
  assert.deepEqual(await requestExtensionMcp(endpoint, {}), {});
  addresses = [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(requestExtensionMcp(endpoint, {}), /public/);
  addresses = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
  await assert.rejects(requestExtensionMcp(endpoint, {}), /public/);
  assert.equal(calls, 2);
  expectedHost = 'catalog.internal';
  addresses = [{ address: '10.0.0.1', family: 4 }];
  assert.deepEqual(await requestExtensionMcp('https://catalog.internal/mcp%2Ftools', {}, undefined, { internalAddresses: ['10.0.0.1'] }), {});
  addresses = [{ address: '10.0.0.2', family: 4 }];
  await assert.rejects(requestExtensionMcp('https://catalog.internal/mcp%2Ftools', {}, undefined, { internalAddresses: ['10.0.0.1'] }), /authorized/);
  assert.equal(calls, 3);
});
