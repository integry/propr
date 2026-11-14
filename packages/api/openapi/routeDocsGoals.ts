import type { RouteDoc } from './types.js';

/** OpenAPI annotations of the goal routes. Only the creation contract is documented so far. */
export const GOAL_ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /api/goals': {
    operationId: 'createGoal',
    summary: 'Create a goal',
    description: [
      'Creates a goal and starts autonomous work on it. The request and response bodies are not described here yet; the MCP tool `create_goal` and `get_goal_capabilities` document the creation contract.',
      '',
      'Creation is idempotent per user and `Idempotency-Key`: repeating a request with the same key and the same body returns the goal it created (`200`) instead of creating another one. Reusing a key with a different body, or a key already used for another goal operation, is rejected with `409`.',
      '',
      'Send JSON, or `multipart/form-data` with the JSON in a `payload` field and up to 10 attachments in `files`.',
    ].join('\n'),
    tags: ['Goals'],
    headers: [{
      name: 'Idempotency-Key',
      required: true,
      maxLength: 255,
      description: 'Client-chosen identity of this creation, for example a UUID. Required; a missing or longer key is rejected with `400`.',
    }],
    responses: {
      200: { description: 'A replay: the goal this key already created, as `{ goal }`.' },
      201: { description: 'The goal was created and its first attempt queued, as `{ goal }`.' },
      400: { description: 'Missing or invalid `Idempotency-Key`, or an invalid body.' },
      403: { description: 'The repository is not accessible to this installation.' },
      409: { description: 'The `Idempotency-Key` was already used with a different body or for a different goal operation.' },
      503: { description: 'The goal was saved but its first attempt could not be queued; recovery retries it. The body carries `goalId`.' },
    },
  },
};
