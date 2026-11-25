import type { RouteDoc } from './types.js';

/** OpenAPI annotations for goal creation and drafts. */
export const GOAL_ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /api/goals': {
    operationId: 'createGoal',
    summary: 'Create a goal',
    description: [
      'Creates a goal and starts autonomous work by default. Set `draft: true` to save it for later. A draft can have an empty objective. The MCP tools `create_goal` and `get_goal_capabilities` describe the launch options.',
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
      201: { description: 'The goal was saved as a draft or created and queued, as `{ goal }`.' },
      400: { description: 'Missing or invalid `Idempotency-Key`, or an invalid body.' },
      403: { description: 'The repository is not accessible to this installation.' },
      409: { description: 'The `Idempotency-Key` was already used with a different body or for a different goal operation.' },
      503: { description: 'The goal was saved but its first attempt could not be queued; recovery retries it. The body carries `goalId`.' },
    },
  },
  'PATCH /api/goals/:goalId/draft': {
    operationId: 'updateGoalDraft',
    summary: 'Save a draft goal description',
    description: 'Updates a saved draft with the JSON `objective` string. The objective can be empty while the goal is a draft.',
    tags: ['Goals'],
    responses: {
      200: { description: 'The updated draft as `{ goal }`.' },
      400: { description: 'The objective is invalid.' },
      404: { description: 'The goal was not found.' },
      409: { description: 'The goal is no longer a draft.' },
    },
  },
  'POST /api/goals/:goalId/start': {
    operationId: 'startGoalDraft',
    summary: 'Start a saved goal draft',
    description: 'Validates the saved objective and runtime, then queues the first attempt. Retrying a started draft returns its current state.',
    tags: ['Goals'],
    responses: {
      200: { description: 'The goal as `{ goal }`.' },
      400: { description: 'The objective or runtime selection is invalid.' },
      403: { description: 'The repository is not accessible to this installation.' },
      404: { description: 'The goal was not found.' },
      409: { description: 'The draft changed, the goal was created without a draft, or the runtime is unavailable.' },
      503: { description: 'The goal was saved but its first attempt could not be queued. Recovery retries it.' },
    },
  },
};
