import { ProprClientError } from './errors.js';

/**
 * The dashboard API operations `@propr/client` calls, keyed by their OpenAPI
 * `operationId`. Client code builds every API path from this table, and
 * `npm run check:client-contract` compares it, and the signatures of the
 * `ProprClient` methods named here, with docs/static/openapi/propr-api.yaml.
 */
export interface ProprApiOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI path template, for example `/api/task/{taskId}/history`. */
  path: string;
  /** The `ProprClient` method that performs this operation, when there is one. */
  clientMethod?: string;
  /** Generated type of the query parameters (`ProprApi.<name>`). */
  query?: string;
  /** Generated type of the JSON request body (`ProprApi.<name>`). */
  requestBody?: string;
  /** Generated type of every successful JSON response (`ProprApi.<name>`). */
  response?: string;
}

export const PROPR_API_OPERATIONS = {
  getCompatibility: { method: 'GET', path: '/api/compatibility', clientMethod: 'negotiateCompatibility' },
  getDesktopDiscovery: { method: 'GET', path: '/api/desktop/discovery', clientMethod: 'discoverDesktop' },
  // desktopPairing.ts also checks the values (formats, deadlines, the binding) at runtime.
  startDesktopPairing: {
    method: 'POST',
    path: '/api/desktop/pairings',
    clientMethod: 'startDesktopPairing',
    requestBody: 'DesktopPairingStartRequest',
    response: 'DesktopPairingStart',
  },
  pollDesktopPairing: {
    method: 'POST',
    path: '/api/desktop/pairings/{pairingId}/poll',
    requestBody: 'DesktopPairingPollRequest',
    response: 'DesktopPairingPoll',
  },
  activateDesktopPairing: {
    method: 'POST',
    path: '/api/desktop/pairings/{pairingId}/activate',
    clientMethod: 'activateDesktopPairing',
    requestBody: 'DesktopPairingTicket',
    response: 'DesktopPairingActivationReceipt',
  },
  cancelDesktopPairing: {
    method: 'POST',
    path: '/api/desktop/pairings/{pairingId}/cancel',
    clientMethod: 'cancelDesktopPairing',
    requestBody: 'DesktopPairingTicket',
    response: 'DesktopPairingCancellation',
  },
  listTasks: { method: 'GET', path: '/api/tasks', clientMethod: 'listTasks', query: 'ListTasksQuery', response: 'TaskPage' },
  getTaskHistory: { method: 'GET', path: '/api/task/{taskId}/history', clientMethod: 'getTaskHistory', response: 'TaskHistory' },
  createTaskSubmission: {
    method: 'POST',
    path: '/api/task-submissions',
    clientMethod: 'createTaskSubmission',
    requestBody: 'TaskSubmissionRequest',
    response: 'TaskSubmission',
  },
  getTaskSubmission: { method: 'GET', path: '/api/task-submissions/{key}', clientMethod: 'getTaskSubmission', response: 'TaskSubmission' },
  retryTaskSubmission: {
    method: 'POST',
    path: '/api/task-submissions/{key}/retry',
    clientMethod: 'retryTaskSubmission',
    response: 'TaskSubmission',
  },
} as const satisfies Record<string, ProprApiOperation>;

export type ProprApiOperationId = keyof typeof PROPR_API_OPERATIONS;

/** HTTP method of an operation; client requests take it from here, never spell it. */
export function operationMethod(operationId: ProprApiOperationId): ProprApiOperation['method'] {
  return PROPR_API_OPERATIONS[operationId].method;
}

/** Expand an operation's path template; every value is URI-encoded. */
export function operationPath(
  operationId: ProprApiOperationId,
  parameters: Record<string, string | number> = {},
): string {
  return PROPR_API_OPERATIONS[operationId].path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined || value === '') {
      throw new ProprClientError(`The ${name} path parameter of ${operationId} is required.`, { kind: 'configuration' });
    }
    return encodeURIComponent(String(value));
  });
}

/** Append defined query values to a path, in insertion order. */
export function withQuery(path: string, query: object = {}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(name, String(value));
  }
  const encoded = search.toString();
  return encoded ? `${path}?${encoded}` : path;
}
