/**
 * Response shape from GET /status/:agent
 *
 * Declared apart from the service so the usage change-detection module can
 * describe a snapshot without importing the configuration and HTTP machinery
 * that fetching one needs.
 *
 * Example call:
 *   const status = await getStatus('claude');
 *   // GET http://0.0.0.0:3456/status/claude
 *   // => { "name": "claude", "usage": { "session": { "percent": 42, ... }, ... }, ... }
 */
export interface AgentStatusResponse {
    name: string;
    usage: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    lastUpdated?: string;
    error?: string | null;
    isRefreshing?: boolean;
}
