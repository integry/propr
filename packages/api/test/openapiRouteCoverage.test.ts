import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Validator } from '@seriousme/openapi-schema-validator';
import YAML from 'yaml';
import { buildOpenApiDocument, expressPathToOpenApi, goalTaskGuarded } from '../openapi/buildSpec.js';
import { renderClientTypes } from '../openapi/clientTypes.js';
import { DIRECT_ROUTE_REGISTRATIONS, GOAL_TASK_GUARD_MOUNTS } from '../openapi/directRoutes.js';
import { listRegisteredRoutes, routeKey } from '../openapi/registeredRoutes.js';
import { ROUTE_DOCS } from '../openapi/routeDocs.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const committedSpecPath = path.resolve(apiRoot, '../../docs/static/openapi/propr-api.yaml');

type Operation = Record<string, unknown>;

function operations(document: { paths: Record<string, Record<string, Operation>> }): Map<string, Operation> {
  const result = new Map<string, Operation>();
  for (const [specPath, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) result.set(`${method.toUpperCase()} ${specPath}`, operation);
  }
  return result;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    if (['node_modules', 'dist', 'test'].includes(entry.name)) return Promise.resolve([]);
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return Promise.resolve(entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [target] : []);
  }));
  return nested.flat();
}

describe('OpenAPI spec generated from the route registry', () => {
  const document = buildOpenApiDocument();
  const specOperations = operations(document);

  it('validates against the OpenAPI 3.1 schema', async () => {
    const result = await new Validator().validate(structuredClone(document) as unknown as Record<string, unknown>);
    assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
    assert.equal(document.openapi, '3.1.0');
  });

  it('lists every registered route, documented or x-undocumented', () => {
    const routes = listRegisteredRoutes();
    assert.ok(routes.length > 200, 'the registry should expose the full route table');
    for (const route of routes) {
      const operation = specOperations.get(`${route.method.toUpperCase()} ${expressPathToOpenApi(route.path)}`);
      assert.ok(operation, `${routeKey(route)} is missing from the spec`);
      const documented = Boolean(ROUTE_DOCS[routeKey(route)]);
      assert.equal(operation['x-undocumented'], documented ? undefined : true, routeKey(route));
    }
    assert.equal(specOperations.size, routes.length, 'the spec lists only registered routes');
    const coverage = document.info['x-route-coverage'] as { total: number; undocumented: number };
    assert.equal(coverage.total, routes.length);
    assert.equal(coverage.undocumented, [...specOperations.values()].filter(operation => operation['x-undocumented']).length);
  });

  it('annotates only registered routes and keeps operation ids unique', () => {
    const keys = new Set(listRegisteredRoutes().map(routeKey));
    for (const key of Object.keys(ROUTE_DOCS)) assert.ok(keys.has(key), `${key} is annotated but not registered`);
    const ids = [...specOperations.values()].map(operation => operation.operationId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('marks ad-hoc error shapes x-legacy-error and documents the common envelope', () => {
    const schemas = document.components.schemas as Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    assert.deepEqual(schemas.ErrorEnvelope.required, ['code', 'message']);
    assert.ok(schemas.ErrorEnvelope.properties?.hint);
    for (const [key, operation] of specOperations) {
      const legacy = operation['x-legacy-error'] === true;
      const defaultResponse = (operation.responses as Record<string, { $ref?: string }>).default.$ref;
      assert.equal(defaultResponse, `#/components/responses/${legacy ? 'Legacy' : 'Envelope'}UnexpectedError`, key);
    }
  });

  it('records authentication and guard permissions on each operation', () => {
    const listTasks = specOperations.get('GET /api/tasks')!;
    assert.deepEqual(listTasks.security, [{ sessionCookie: [] }, { bearerAuth: [] }]);
    const settings = specOperations.get('GET /api/config/settings')!;
    assert.equal(settings['x-propr-permission'], 'instance.manage_settings');
    assert.deepEqual(specOperations.get('GET /api/compatibility')!.security, []);
    assert.deepEqual(specOperations.get('POST /api/mcp')!.security, [{ mcpOAuth: ['read'] }]);
  });

  it('documents the MCP OAuth endpoints the mcpOAuth scheme points at', () => {
    const scheme = document.components.securitySchemes.mcpOAuth as { flows: { authorizationCode: { authorizationUrl: string; tokenUrl: string } } };
    const { authorizationUrl, tokenUrl } = scheme.flows.authorizationCode;
    for (const key of [`GET ${authorizationUrl}`, `POST ${authorizationUrl}`, `POST ${tokenUrl}`, 'POST /register', 'POST /revoke',
      'GET /.well-known/oauth-protected-resource/api/mcp']) {
      const operation = specOperations.get(key);
      assert.ok(operation, `${key} is missing from the spec`);
      assert.equal(operation['x-undocumented'], undefined, `${key} is not documented`);
      assert.deepEqual(operation.security, [], `${key} is public`);
    }
  });

  it('notes the goal-task ownership guard on the routes it can act on', () => {
    const guarded = (key: string) => {
      const operation = specOperations.get(key)!;
      assert.ok(operation, key);
      return { operation, responses: operation.responses as Record<string, { description: string }> };
    };
    const history = guarded('GET /api/task/{taskId}/history');
    assert.match(history.operation.description as string, /goal owner/);
    assert.ok(history.responses['404']);
    assert.equal(history.responses['409'], undefined, 'reads are allowed for the goal owner');
    const deletion = guarded('DELETE /api/tasks/{taskId}');
    assert.match(deletion.responses['409'].description, /goal/);
    // A literal segment in the id position is not a task id; the guard finds no goal.
    assert.equal(goalTaskGuarded({ path: '/api/tasks/stats' }), false);
    assert.equal(goalTaskGuarded({ path: '/api/task/:taskId' }), true);
    assert.equal(goalTaskGuarded({ path: '/api/execution/:sessionId/messages/:index' }), true);
    assert.equal(goalTaskGuarded({ path: '/api/task-submissions/:key' }), false);
    const unguarded = guarded('GET /api/tasks');
    assert.doesNotMatch((unguarded.operation.description as string | undefined) ?? '', /goal owner/);
  });

  it('names each query type by its parameter set, so alias routes share it', () => {
    const deleteTask = specOperations.get('DELETE /api/tasks/{taskId}')!;
    const legacy = [...specOperations.values()].find(operation => operation.operationId === 'deleteTaskLegacyPath')!;
    assert.equal(deleteTask['x-propr-query-type'], 'DeleteTaskQuery');
    assert.equal(legacy['x-propr-query-type'], 'DeleteTaskQuery');
    const types = renderClientTypes(document);
    assert.equal(types.match(/export interface DeleteTaskQuery\b/g)?.length, 1);
    assert.doesNotMatch(types, /DeleteTaskLegacyPathQuery/);
    for (const operation of specOperations.values()) {
      const query = ((operation.parameters ?? []) as { in: string }[]).some(parameter => parameter.in === 'query');
      if (!operation['x-undocumented']) assert.equal(Boolean(operation['x-propr-query-type']), query, String(operation.operationId));
    }
  });

  it('names the session cookie the API sets', async () => {
    const scheme = document.components.securitySchemes.sessionCookie as { name: string };
    const auth = await readFile(path.join(apiRoot, 'auth.ts'), 'utf8');
    const sessionOptions = auth.slice(auth.indexOf('session({'), auth.indexOf('});', auth.indexOf('session({')));
    const configured = sessionOptions.match(/^\s{12,16}name:\s*['"]([^'"]+)['"]/m)?.[1];
    // express-session's default, unless auth.ts configures its own name.
    assert.equal(scheme.name, configured ?? 'connect.sid');
    const authSession = await readFile(path.join(apiRoot, 'authSession.ts'), 'utf8');
    assert.match(authSession, new RegExp(`clearCookie\\('${scheme.name.replace('.', '\\.')}'`));
  });

  it('matches the committed docs/static/openapi/propr-api.yaml', async () => {
    const committed = YAML.parse(await readFile(committedSpecPath, 'utf8'));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(document)), 'run `npm run gen:openapi`');
  });
});

describe('Routes registered outside routeRegistry.ts', () => {
  it('are all listed in DIRECT_ROUTE_REGISTRATIONS', async () => {
    const listed = new Set(DIRECT_ROUTE_REGISTRATIONS.map(routeKey));
    const pattern = /(?<![.\w])(app|router)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3/g;
    const found: string[] = [];
    for (const file of await sourceFiles(apiRoot)) {
      const contents = await readFile(file, 'utf8');
      for (const [, receiver, method, , routePath] of contents.matchAll(pattern)) {
        // `/api/agents` mounts the only Express router.
        const fullPath = receiver === 'router' ? `/api/agents${routePath}` : routePath;
        const methods = method === 'all' ? ['get', 'post', 'delete'] : [method];
        for (const verb of methods) found.push(`${verb.toUpperCase()} ${fullPath}`);
      }
    }
    assert.ok(found.length > 20, 'the source scan should find the direct registrations');
    for (const key of found) assert.ok(listed.has(key), `${key} is registered directly; list it in openapi/directRoutes.ts`);
  });

  it('leave no app.use-mounted handler undocumented', async () => {
    const shape = (routePath: string) => routePath.split('/').filter(Boolean).filter(segment => !segment.startsWith('*'))
      .map(segment => (segment.startsWith(':') ? ':' : segment));
    const routes = listRegisteredRoutes().map(route => shape(route.path));
    const covered = (mount: string) => {
      const prefix = shape(mount);
      return routes.some(route => prefix.length <= route.length
        && prefix.every((segment, index) => segment === ':' ? route[index] === ':' : segment === route[index]));
    };
    const mounts: string[] = [];
    const single = /(?<![.\w])app\.use\(\s*(['"`])([^'"`]+)\1/g;
    const list = /(?<![.\w])app\.use\(\s*\[([^\]]*)\]/g;
    for (const file of await sourceFiles(apiRoot)) {
      const contents = await readFile(file, 'utf8');
      for (const [, , mount] of contents.matchAll(single)) mounts.push(mount);
      for (const [, entries] of contents.matchAll(list)) {
        for (const [, , mount] of entries.matchAll(/(['"`])([^'"`]+)\1/g)) mounts.push(mount);
      }
    }
    assert.ok(mounts.includes('/authorize') && mounts.includes('/token'), 'the scan should find the MCP OAuth mounts');
    for (const mount of mounts) assert.ok(covered(mount), `app.use('${mount}') serves no listed route; document it in openapi/directRoutes.ts`);

    // The SDK router is mounted at the root and filtered by MCP_AUTH_PATHS.
    const mcpServer = await readFile(path.join(apiRoot, 'mcp/server.ts'), 'utf8');
    const authPaths = mcpServer.match(/const MCP_AUTH_PATHS = \[([^\]]+)\]/)?.[1];
    assert.ok(authPaths, 'mcp/server.ts declares MCP_AUTH_PATHS');
    for (const [, , authPath] of authPaths.matchAll(/(['"`])([^'"`]+)\1/g)) {
      assert.ok(covered(authPath), `${authPath} (MCP_AUTH_PATHS) is not documented`);
    }
  });

  it('server.ts mounts the goal-task ownership guard on GOAL_TASK_GUARD_MOUNTS', async () => {
    const server = await readFile(path.join(apiRoot, 'server.ts'), 'utf8');
    const mounts = [...server.matchAll(/app\.use\(([^\n]*)goalRoutes\.requireGoalTaskOwnership\)/g)].map(([, mount]) => mount.trim());
    assert.deepEqual(mounts, ['[...GOAL_TASK_GUARD_MOUNTS],']);
    assert.ok(GOAL_TASK_GUARD_MOUNTS.length > 0);
  });

  it('server.ts registers every registry table the generator reads', async () => {
    const server = await readFile(path.join(apiRoot, 'server.ts'), 'utf8');
    for (const table of ['createOperationalRouteEntries', 'createMemberCatalogRouteEntries', 'createManagementRouteEntries']) {
      assert.match(server, new RegExp(`${table}\\(`), table);
    }
  });
});
