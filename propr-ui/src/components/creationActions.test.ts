import { describe, expect, it } from 'vitest';
import { getCreationActions } from './creationActions';

describe('route creation actions', () => {
  it.each([
    ['/plans', 'plan'], ['/plans/', 'plan'], ['/plans/plan-1', 'plan'],
    ['/studio', 'plan'], ['/studio/new', 'plan'], ['/studio/draft-1', 'plan'],
    ['/goals', 'goal'], ['/goals/', 'goal'], ['/goals/goal-1', 'goal'],
    ['/Goals/goal-1', 'goal'],
    ['/automations', 'automation'], ['/automations/new', 'automation'],
    ['/automations/def-1/runs/run-1', 'automation'],
    ['/', 'task'], ['/tasks', 'task'], ['/tasks/new', 'task'],
    ['/tasks/task-1', 'task'], ['/repositories', 'task'],
    ['/repositories/acme/goals', 'task'], ['/settings', 'task'],
    ['/plans-other', 'task'], ['/studio-other', 'task'], ['/goals-other', 'task'],
    ['/automations-other', 'task'],
  ])('%s selects %s and offers the other actions', (pathname, expected) => {
    const { primary, secondary } = getCreationActions(pathname);
    expect(primary.id).toBe(expected);
    expect(secondary.map(action => action.id)).toEqual(
      ['task', 'plan', 'goal', 'automation'].filter(id => id !== expected),
    );
  });
});
