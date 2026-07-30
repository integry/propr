import type { Express, RequestHandler } from 'express';
import type {
  createAdminRoutes,
  createAgentLoginRoutes,
  createAgentRuntimeRoutes,
  createAgentVersionRoutes,
  createConfigRoutes,
  createInstanceCatalogRoutes,
} from './routes/index.js';
import {
  requireManageAgents,
  requireManageMembers,
  requireManageRuntime,
  requireManageSettings,
} from './permissionGuards.js';

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type RouteEntry = [RouteMethod, string, ...RequestHandler[]];

interface ManagementRouteDeps {
  adminRoutes: ReturnType<typeof createAdminRoutes>;
  agentLoginRoutes: ReturnType<typeof createAgentLoginRoutes>;
  agentRuntimeRoutes: ReturnType<typeof createAgentRuntimeRoutes>;
  agentVersionRoutes: ReturnType<typeof createAgentVersionRoutes>;
  configRoutes: ReturnType<typeof createConfigRoutes>;
}

interface MemberCatalogRouteDeps {
  instanceCatalogRoutes: ReturnType<typeof createInstanceCatalogRoutes>;
}

export function createManagementRouteEntries({
  adminRoutes,
  agentLoginRoutes,
  agentRuntimeRoutes,
  agentVersionRoutes,
  configRoutes,
}: ManagementRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/config/followup-keywords', requireManageSettings, configRoutes.getFollowupKeywords],
    ['post', '/api/config/followup-keywords', requireManageSettings, configRoutes.postFollowupKeywords],
    ['get', '/api/config/followup-ignore-keywords', requireManageSettings, configRoutes.getFollowupIgnoreKeywords],
    ['post', '/api/config/followup-ignore-keywords', requireManageSettings, configRoutes.postFollowupIgnoreKeywords],
    ['get', '/api/config/repos', requireManageSettings, configRoutes.getRepos],
    ['post', '/api/config/repos', requireManageSettings, configRoutes.postRepos],
    ['get', '/api/config/settings', requireManageSettings, configRoutes.getSettings],
    ['post', '/api/config/settings', requireManageSettings, configRoutes.postSettings],
    ['get', '/api/config/pr-label', requireManageSettings, configRoutes.getPrLabel],
    ['post', '/api/config/pr-label', requireManageSettings, configRoutes.postPrLabel],
    ['get', '/api/config/ai-primary-tag', requireManageSettings, configRoutes.getAiPrimaryTag],
    ['post', '/api/config/ai-primary-tag', requireManageSettings, configRoutes.postAiPrimaryTag],
    ['get', '/api/config/primary-processing-labels', requireManageSettings, configRoutes.getPrimaryProcessingLabels],
    ['post', '/api/config/primary-processing-labels', requireManageSettings, configRoutes.postPrimaryProcessingLabels],
    ['get', '/api/config/agents', requireManageAgents, configRoutes.getAgents],
    ['post', '/api/config/agents', requireManageAgents, configRoutes.postAgents],
    ['get', '/api/config/summarization', requireManageSettings, configRoutes.getSummarizationSettings],
    ['post', '/api/config/summarization', requireManageSettings, configRoutes.postSummarizationSettings],
    ['get', '/api/config/repos/indexing-status', requireManageSettings, configRoutes.getRepositoriesIndexingStatus],
    ['post', '/api/config/repos/trigger-indexing', requireManageSettings, configRoutes.triggerIndexing],
    ['post', '/api/config/repos/stop-indexing', requireManageSettings, configRoutes.stopIndexing],
    ['post', '/api/config/summarization/reindex-all', requireManageSettings, configRoutes.triggerReindexAll],
    ['get', '/api/config/agent-tank', requireManageAgents, configRoutes.getAgentTankSettings],
    ['post', '/api/config/agent-tank', requireManageAgents, configRoutes.postAgentTankSettings],
    ['get', '/api/config/agent-tank/status', requireManageAgents, configRoutes.getAgentTankStatus],
    ['get', '/api/config/agent-tank/usage', requireManageAgents, configRoutes.getAgentTankUsage],
    ['post', '/api/config/agent-tank/refresh', requireManageAgents, configRoutes.postAgentTankRefresh],
    ['get', '/api/config/agent-tank/detect', requireManageAgents, configRoutes.getAgentTankDetect],

    ['get', '/api/admin/members', requireManageMembers, adminRoutes.listMembers],
    ['get', '/api/admin/role-audit', requireManageMembers, adminRoutes.listRoleAudit],
    ['post', '/api/admin/members/claim', requireManageMembers, adminRoutes.claimBootstrapAdmin],
    ['post', '/api/admin/members', requireManageMembers, adminRoutes.addMember],
    ['patch', '/api/admin/members/:githubUserId', requireManageMembers, adminRoutes.updateMemberRole],
    ['delete', '/api/admin/members/:githubUserId', requireManageMembers, adminRoutes.removeMember],

    ['get', '/api/agent-runtime/packages', requireManageRuntime, agentRuntimeRoutes.getRuntimePackages],
    ['get', '/api/agent-runtime/packages/search', requireManageRuntime, agentRuntimeRoutes.searchRuntimePackages],
    ['post', '/api/agent-runtime/packages/validate', requireManageRuntime, agentRuntimeRoutes.validateRuntimePackages],
    ['put', '/api/agent-runtime/packages', requireManageRuntime, agentRuntimeRoutes.putRuntimePackages],
    ['post', '/api/agent-runtime/packages/apply', requireManageRuntime, agentRuntimeRoutes.applyRuntimePackages],

    ['post', '/api/agents/:agentId/login-sessions', requireManageAgents, agentLoginRoutes.startLogin],
    ['get', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.getLogin],
    ['post', '/api/agents/:agentId/login-sessions/:sessionId/input', requireManageAgents, agentLoginRoutes.sendInput],
    ['delete', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.cancelLogin],

    ['get', '/api/agents/versions/:agentType', requireManageAgents, agentVersionRoutes.getVersions],
    ['post', '/api/agents/:agentId/build-image', requireManageAgents, agentVersionRoutes.buildImage],
    ['delete', '/api/agents/:agentType/images/cleanup', requireManageAgents, agentVersionRoutes.cleanupImages],
    ['get', '/api/agents/:agentType/images', requireManageAgents, agentVersionRoutes.listImages],
    ['post', '/api/agents/resolve-version', requireManageAgents, agentVersionRoutes.resolveVersionEndpoint],
    ['get', '/api/agents/:agentType/image-tag', requireManageAgents, agentVersionRoutes.getImageTag],
  ];
}

export function createMemberCatalogRouteEntries({
  instanceCatalogRoutes,
}: MemberCatalogRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/catalog', instanceCatalogRoutes.getCatalog],
    ['get', '/api/repositories/indexing-status', instanceCatalogRoutes.getRepositoryIndexingStatus],
  ];
}

export function assertNoDuplicateRoutes(routes: RouteEntry[]): void {
  const seen = new Set<string>();
  routes.forEach(([method, path]) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) throw new Error(`Duplicate route registration detected for ${key}`);
    seen.add(key);
  });
}

export function registerRouteEntries(app: Express, routes: RouteEntry[]): void {
  routes.forEach(([method, path, ...handlers]) => {
    app[method](path, ...handlers);
  });
}
