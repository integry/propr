import { z } from 'zod';
import { PROPR_API_COMPATIBILITY } from '@propr/shared';
import { MCP_SCOPES } from '../mcp/config.js';
import { listRegisteredRoutes, routeKey } from './registeredRoutes.js';
import { ROUTE_DOCS } from './routeDocs.js';
import { apiSchemas, ErrorEnvelope, LegacyError } from './schemas.js';
import type { RegisteredRoute, RouteAuth, RouteDoc } from './types.js';

type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: Record<string, unknown>;
  servers: unknown[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, JsonSchema>; responses: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'] as const;
const COMPONENT_PREFIX = '#/components/schemas/';
const RESPONSE_PREFIX = '#/components/responses/';

const TAGS: { name: string; description: string; prefixes: string[] }[] = [
  { name: 'System', description: 'Health, compatibility and status.', prefixes: ['/health', '/api/compatibility', '/api/status'] },
  { name: 'Authentication', description: 'Browser login and the signed-in user.', prefixes: ['/api/auth'] },
  { name: 'Tasks', description: 'Task runs, their events, output and follow-ups.', prefixes: ['/api/tasks', '/api/task/', '/api/execution', '/api/import-tasks', '/api/pull-requests'] },
  { name: 'Task submissions', description: 'Idempotent creation of new tasks from an instruction.', prefixes: ['/api/task-submissions'] },
  { name: 'Goals', description: 'Long-running goals and their inputs.', prefixes: ['/api/goals'] },
  { name: 'Planner', description: 'Plan Studio drafts, revisions and generation.', prefixes: ['/api/planner'] },
  { name: 'Repositories', description: 'Repository context: summaries, chat, to-dos, media and GitHub metadata.', prefixes: ['/api/repos', '/api/summaries', '/api/repositories', '/api/github', '/api/preview-media', '/api/user'] },
  { name: 'Observability', description: 'Dashboard, statistics, queue, activity and LLM metrics.', prefixes: ['/api/dashboard', '/api/stats', '/api/queue', '/api/activity', '/api/metrics', '/api/llm-', '/api/usage-tips'] },
  { name: 'Notifications', description: 'Inbox notifications, preferences and Web Push subscriptions.', prefixes: ['/api/notifications'] },
  { name: 'Voice', description: 'Spoken briefings.', prefixes: ['/api/voice'] },
  { name: 'Desktop', description: 'Desktop and CLI discovery, pairing and instance tokens.', prefixes: ['/api/desktop'] },
  { name: 'Configuration', description: 'Instance settings. Most routes require a management permission.', prefixes: ['/api/config', '/api/catalog', '/api/instance'] },
  { name: 'Agents', description: 'Agent login, images, runtime packages and health.', prefixes: ['/api/agents', '/api/agent-runtime'] },
  { name: 'Administration', description: 'Instance members and MCP administration.', prefixes: ['/api/admin'] },
  { name: 'MCP', description: 'The Model Context Protocol endpoint and its browser pages.', prefixes: ['/api/mcp', '/mcp', '/.well-known'] },
  { name: 'Webhooks', description: 'GitHub webhook intake.', prefixes: ['/webhook'] },
];

const SECURITY: Record<RouteAuth, Record<string, string[]>[]> = {
  member: [{ sessionCookie: [] }, { bearerAuth: [] }],
  public: [],
  instanceToken: [{ bearerAuth: [] }],
  mcp: [{ mcpOAuth: ['read'] }],
  webhook: [{ webhookSignature: [] }],
  browserSession: [{ sessionCookie: [] }],
};

const INFO_DESCRIPTION = `The HTTP API the ProPR web UI, desktop app and CLI use. It is served by the dashboard API process under \`/api\`.

## Authentication

Unless an operation says otherwise, send one of:

- the browser session cookie set by \`GET /api/auth/github\`;
- \`Authorization: Bearer <GitHub token>\`, accepted while \`ENABLE_BEARER_AUTH\` is not \`false\` (the default);
- \`Authorization: Bearer propr_it_…\`, a desktop or CLI instance token issued by pairing.

The caller's GitHub account must be allowed on the instance. Operations with \`x-propr-permission\` also need that instance permission (admins have all of them). Demo instances reject every mutating request.

## Errors

New routes answer every error with the \`ErrorEnvelope\` (\`code\`, \`message\`, optional \`hint\`). Existing routes still return the ad-hoc \`LegacyError\` (\`{ "error": "…" }\`) and are marked \`x-legacy-error: true\`.

## Coverage

Every registered route is listed. Routes without an annotation carry \`x-undocumented: true\`; \`info.x-route-coverage\` counts them.`;

export function expressPathToOpenApi(path: string): string {
  return path.replace(/[:*]([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function pathParameterNames(path: string): { name: string; wildcard: boolean }[] {
  return [...path.matchAll(/([:*])([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => ({ name: match[2], wildcard: match[1] === '*' }));
}

export function autoOperationId(method: string, path: string): string {
  const words = path.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1));
  return `${method}${words.join('')}`;
}

function tagFor(path: string): string {
  const tag = TAGS.find(candidate => candidate.prefixes.some(prefix => path === prefix || path.startsWith(prefix)));
  if (!tag) throw new Error(`No OpenAPI tag covers ${path}; add a prefix to TAGS in buildSpec.ts`);
  return tag.name;
}

/** Remove generator noise so the committed YAML stays readable and stable. */
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (!value || typeof value !== 'object') return value;
  const result: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === '$id') continue;
    if (key === 'minimum' && child === Number.MIN_SAFE_INTEGER) continue;
    if (key === 'maximum' && child === Number.MAX_SAFE_INTEGER) continue;
    result[key] = tidy(child);
  }
  return result;
}

function schemaRef(schema: z.ZodType, context: string): JsonSchema {
  const id = apiSchemas.get(schema)?.id;
  if (!id) throw new Error(`${context}: register the schema in openapi/schemas.ts with component()`);
  return { $ref: `${COMPONENT_PREFIX}${id}` };
}

function errorContent(doc: RouteDoc | undefined): Record<string, unknown> {
  const schema = doc?.errors === 'envelope' ? ErrorEnvelope : LegacyError;
  return { 'application/json': { schema: schemaRef(schema, 'error schema') } };
}

function queryParameters(doc: RouteDoc): unknown[] {
  if (!doc.query) return [];
  const schema = z.toJSONSchema(doc.query, { io: 'input' }) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: 'query',
      required: schema.required?.includes(name) ?? false,
      ...(description ? { description } : {}),
      schema: tidy(rest),
    };
  });
}

function parameters(route: RegisteredRoute, doc: RouteDoc | undefined): unknown[] {
  const path = pathParameterNames(route.path).map(({ name, wildcard }) => {
    const description = doc?.pathParams?.[name] ?? (wildcard ? 'Remaining path; may contain `/`.' : undefined);
    return { name, in: 'path', required: true, ...(description ? { description } : {}), schema: { type: 'string' } };
  });
  const headers = (doc?.headers ?? []).map(header => ({
    name: header.name,
    in: 'header',
    required: header.required ?? false,
    description: header.description,
    schema: { type: 'string', ...(header.maxLength ? { maxLength: header.maxLength } : {}) },
  }));
  return [...path, ...(doc ? queryParameters(doc) : []), ...headers];
}

function requestBody(doc: RouteDoc, key: string): Record<string, unknown> | undefined {
  if (!doc.requestBody) return undefined;
  const { schema, description, multipartFiles } = doc.requestBody;
  const ref = schemaRef(schema, `${key} request body`);
  const content: Record<string, unknown> = { 'application/json': { schema: ref } };
  if (multipartFiles) {
    const name = (ref.$ref as string).slice(COMPONENT_PREFIX.length);
    content['multipart/form-data'] = {
      schema: {
        type: 'object',
        required: ['payload'],
        properties: {
          payload: { type: 'string', description: `The \`${name}\` as a JSON string.`, contentMediaType: 'application/json' },
          files: { type: 'array', maxItems: multipartFiles.maxFiles, items: { type: 'string', contentMediaType: 'application/octet-stream' } },
        },
      },
    };
  }
  return { required: true, ...(description ? { description } : {}), content };
}

function responses(route: RegisteredRoute, doc: RouteDoc | undefined, key: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const documented = doc?.responses ?? { 200: { description: 'Success. The response body is not documented yet.' } };
  for (const [status, response] of Object.entries(documented)) {
    const isError = Number(status) >= 400;
    const content = response.schema
      ? { [response.contentType ?? 'application/json']: { schema: schemaRef(response.schema, `${key} ${status} response`) } }
      : response.contentType ? { [response.contentType]: { schema: { type: 'string' } } }
        : isError ? errorContent(doc) : undefined;
    result[status] = { description: response.description, ...(content ? { content } : {}) };
  }
  const prefix = doc?.errors === 'envelope' ? 'Envelope' : 'Legacy';
  if (['member', 'instanceToken', 'mcp'].includes(route.auth) && !result['401']) {
    result['401'] = { $ref: `${RESPONSE_PREFIX}${prefix}Unauthorized` };
  }
  if (route.permission && !result['403']) result['403'] = { $ref: `${RESPONSE_PREFIX}${prefix}Forbidden` };
  result.default = { $ref: `${RESPONSE_PREFIX}${prefix}UnexpectedError` };
  return result;
}

/** Identity and prose of an operation; undocumented routes get generated values. */
function describeOperation(route: RegisteredRoute, doc: RouteDoc | undefined): Operation {
  const permissionNote = route.permission ? `Requires the \`${route.permission}\` instance permission.` : undefined;
  const description = [doc ? doc.description : 'This route is registered but not documented yet.', permissionNote]
    .filter(Boolean).join('\n\n');
  return {
    operationId: doc?.operationId ?? autoOperationId(route.method, route.path),
    summary: doc?.summary ?? `${route.method.toUpperCase()} ${expressPathToOpenApi(route.path)}`,
    ...(description ? { description } : {}),
    tags: doc?.tags ?? [tagFor(route.path)],
    ...(doc?.deprecated ? { deprecated: true } : {}),
  };
}

function buildOperation(route: RegisteredRoute): Operation {
  const key = routeKey(route);
  const doc = ROUTE_DOCS[key];
  const params = parameters(route, doc);
  const body = doc ? requestBody(doc, key) : undefined;
  return {
    ...describeOperation(route, doc),
    security: SECURITY[route.auth],
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: body } : {}),
    responses: responses(route, doc, key),
    'x-propr-auth': route.auth,
    ...(route.permission ? { 'x-propr-permission': route.permission } : {}),
    ...(doc ? {} : { 'x-undocumented': true }),
    ...(doc?.errors === 'envelope' ? {} : { 'x-legacy-error': true }),
  };
}

/** Shared error responses, in the legacy shape and in the common envelope. */
function componentResponses(): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [prefix, schema] of [['Envelope', ErrorEnvelope], ['Legacy', LegacyError]] as const) {
    const content = { 'application/json': { schema: schemaRef(schema, 'error schema') } };
    responses[`${prefix}Unauthorized`] = { description: 'Authentication is missing or invalid.', content };
    responses[`${prefix}Forbidden`] = { description: 'The caller lacks the instance permission named in `x-propr-permission`.', content };
    responses[`${prefix}UnexpectedError`] = { description: 'Unexpected error.', content };
  }
  return responses;
}

function componentSchemas(): Record<string, JsonSchema> {
  const { schemas } = z.toJSONSchema(apiSchemas, { uri: id => `${COMPONENT_PREFIX}${id}` }) as { schemas: Record<string, JsonSchema> };
  return Object.fromEntries(Object.keys(schemas).sort().map(id => [id, tidy(schemas[id]) as JsonSchema]));
}

function assertConsistent(routes: RegisteredRoute[]): void {
  const keys = new Set(routes.map(routeKey));
  const stale = Object.keys(ROUTE_DOCS).filter(key => !keys.has(key));
  if (stale.length) throw new Error(`ROUTE_DOCS annotates routes that are not registered: ${stale.join(', ')}`);
  const templates = new Map<string, string>();
  for (const route of routes) {
    const path = expressPathToOpenApi(route.path);
    const shape = path.replace(/\{[^}]+\}/g, '{}');
    const existing = templates.get(shape);
    if (existing && existing !== path) throw new Error(`OpenAPI paths ${existing} and ${path} differ only in parameter names`);
    templates.set(shape, path);
  }
}

/** Build the OpenAPI 3.1 document for every registered dashboard API route. */
export function buildOpenApiDocument(routes: RegisteredRoute[] = listRegisteredRoutes()): OpenApiDocument {
  assertConsistent(routes);
  const paths: OpenApiDocument['paths'] = {};
  const operationIds = new Set<string>();
  // Code-point order, so the output does not depend on the generating machine's locale.
  const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const sorted = [...routes].sort((left, right) => byPath(expressPathToOpenApi(left.path), expressPathToOpenApi(right.path))
    || METHOD_ORDER.indexOf(left.method) - METHOD_ORDER.indexOf(right.method));
  for (const route of sorted) {
    const operation = buildOperation(route);
    const operationId = operation.operationId as string;
    if (operationIds.has(operationId)) throw new Error(`Duplicate operationId ${operationId}`);
    operationIds.add(operationId);
    (paths[expressPathToOpenApi(route.path)] ??= {})[route.method] = operation;
  }
  const documented = routes.filter(route => ROUTE_DOCS[routeKey(route)]).length;
  return {
    openapi: '3.1.0',
    info: {
      title: 'ProPR Dashboard API',
      version: PROPR_API_COMPATIBILITY,
      summary: 'REST API of a self-hosted ProPR instance.',
      description: INFO_DESCRIPTION,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      'x-route-coverage': { total: routes.length, documented, undocumented: routes.length - documented },
    },
    servers: [{
      url: '{origin}',
      description: 'Your ProPR API origin, for example the value of `API_PUBLIC_URL`.',
      variables: { origin: { default: 'http://localhost:4000' } },
    }],
    tags: TAGS.map(({ name, description }) => ({ name, description })),
    paths,
    components: {
      schemas: componentSchemas(),
      responses: componentResponses(),
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'connect.sid',
          description: 'Browser session created by the GitHub OAuth login.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A GitHub token (when `ENABLE_BEARER_AUTH` is not `false`) or a desktop/CLI instance token (`propr_it_…`).',
        },
        mcpOAuth: {
          type: 'oauth2',
          description: 'OAuth 2.1 access token issued to MCP clients. Every token carries `read`; tools require further scopes.',
          flows: {
            authorizationCode: {
              authorizationUrl: '/authorize',
              tokenUrl: '/token',
              scopes: Object.fromEntries(MCP_SCOPES.map(scope => [scope, `MCP \`${scope}\` scope`])),
            },
          },
        },
        webhookSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Hub-Signature-256',
          description: 'HMAC SHA-256 signature of the body with `GH_WEBHOOK_SECRET`.',
        },
      },
    },
  };
}
