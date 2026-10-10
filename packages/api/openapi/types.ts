import type { z } from 'zod';
import type { InstancePermission } from '@propr/shared';
import type { RouteMethod } from '../routeRegistry.js';

/**
 * How a route authenticates its caller.
 *
 * - `member`: the shared API guard. A browser session cookie, a GitHub bearer
 *   token (`ENABLE_BEARER_AUTH`, on by default) or a desktop instance token.
 * - `public`: no credentials; discovery, pairing bootstrap and login flows.
 * - `instanceToken`: possession of the desktop instance token being acted on.
 * - `mcp`: an MCP OAuth access token; the tool decides the required scope.
 * - `webhook`: a GitHub webhook signature (`X-Hub-Signature-256`).
 * - `browserSession`: a browser session cookie only (HTML consent pages).
 * - `fleetSecret`: the hosted Fleet control secret (`x-propr-fleet-secret`).
 */
export type RouteAuth = 'member' | 'public' | 'instanceToken' | 'mcp' | 'webhook' | 'browserSession' | 'fleetSecret';

export interface RegisteredRoute {
  method: RouteMethod;
  /** Express path, for example `/api/task/:taskId/history`. */
  path: string;
  auth: RouteAuth;
  /** Instance permission enforced by a route guard, when any. */
  permission?: InstancePermission;
  /** Where the route is registered, for readers of the generated spec. */
  source: string;
}

export interface ResponseDoc {
  description: string;
  /** A schema registered in `apiSchemas`; omitted for empty or non-JSON bodies. */
  schema?: z.ZodType;
  contentType?: string;
}

export interface HeaderDoc {
  name: string;
  description: string;
  required?: boolean;
  maxLength?: number;
}

/** OpenAPI annotation of one registered route. */
export interface RouteDoc {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  query?: z.ZodObject;
  pathParams?: Record<string, string>;
  headers?: HeaderDoc[];
  requestBody?: {
    /** JSON body; a schema registered in `apiSchemas`. */
    schema: z.ZodType;
    description?: string;
    /**
     * Also accept `multipart/form-data` with the JSON body in a `payload` field
     * and up to `maxFiles` attachments in `files`.
     */
    multipartFiles?: { maxFiles: number };
  };
  responses: Record<string, ResponseDoc>;
  /**
   * `legacy` (the default) marks the operation `x-legacy-error`: its errors use
   * the ad-hoc `LegacyError` shape. `envelope` routes return `ErrorEnvelope`.
   */
  errors?: 'legacy' | 'envelope';
  deprecated?: boolean;
}
