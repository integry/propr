import { area } from '../lib/world';
import { NOW, REPOS } from './base';

const origin = 'https://propr.northwind.dev';
const scopeCeiling = ['read', 'plan', 'publish', 'execute', 'review'];

/** MCP enabled for chat clients, with an admin scope ceiling, and a day of the access log. */
const clients = [
  { clientId: 'client-claude', clientName: 'Claude' },
  { clientId: 'client-cursor', clientName: 'Cursor' },
];
const calls: Array<[string, string, string, number, number]> = [
  // name, repository, outcome, seconds ago, duration ms
  ['get_work_overview', REPOS.web, 'success', 20, 142],
  ['list_goal_attention', REPOS.api, 'success', 95, 88],
  ['create_plan', REPOS.web, 'success', 160, 2310],
  ['search_repository_files', REPOS.mobile, 'success', 240, 412],
  ['send_goal_input', REPOS.api, 'success', 410, 196],
  ['get_task', REPOS.infra, 'denied', 530, 31],
  ['review_pull_request', REPOS.api, 'success', 700, 640],
  ['list_tasks', REPOS.web, 'success', 820, 120],
];
const rows = calls.map(([name, repository, outcome, seconds, durationMs], index) => {
  const client = clients[index % 3 === 1 ? 1 : 0];
  return {
    id: 900 - index, occurredAt: NOW.getTime() - seconds * 1000, ownerId: '1042', grantId: `grant-${client.clientId}`,
    clientId: client.clientId, clientName: client.clientName, membershipSource: 'local', kind: 'tool', name, repository,
    scope: name.includes('create') || name.includes('send') || name.includes('review') ? 'plan' : 'read', readOnly: !name.includes('create'),
    status: outcome === 'success' ? 200 : 403, outcome, errorCode: outcome === 'denied' ? 'FORBIDDEN_REPOSITORY' : null,
    durationMs, resultBytes: 1024 + index * 611, operationId: null, protocolVersion: '2026-06-18', requestId: String(index),
  };
});

export const mcp = area('mcp', {
  '/api/admin/mcp': {
    status: { enabled: true, origin, resource: `${origin}/mcp`, connectAvailable: false, scopeCeiling },
    settings: { enabled: true, scopeCeiling, connectEnabled: false },
    scopes: ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'],
  },
  '/api/admin/mcp/logs': {
    data: rows,
    pagination: { page: 1, limit: 50, offset: 0, total: 412, totalPages: 9, hasNextPage: true, hasPreviousPage: false },
    filters: {},
  },
  '/api/admin/mcp/logs/stats': {
    data: {
      window: { since: NOW.getTime() - 86_400_000, until: NOW.getTime() }, total: 412,
      outcomes: { success: 405, denied: 6, error: 1 },
      topTools: [{ name: 'get_work_overview', count: 131 }, { name: 'list_tasks', count: 88 }, { name: 'create_plan', count: 23 }],
      topClients: [{ clientId: 'client-claude', clientName: 'Claude', count: 297 }, { clientId: 'client-cursor', clientName: 'Cursor', count: 115 }],
      topRepositories: [{ repository: REPOS.web, count: 190 }], errorCodes: [{ errorCode: 'FORBIDDEN_REPOSITORY', count: 6 }],
      durationMs: { p50: 131, p95: 1940 },
    },
  },
});
