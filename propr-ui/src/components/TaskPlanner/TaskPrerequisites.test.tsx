import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlanTask } from '../../api/proprApi';
import { TaskPrerequisites } from './TaskPrerequisites';
import { resolveTaskPrerequisites } from './taskPrerequisiteSteps';

const task = (id: string, title: string, dependsOn?: string[]): PlanTask => ({ id, title, body: '', implementation: '', ...(dependsOn ? { dependsOn } : {}) });

describe('TaskPrerequisites', () => {
  it('resolves dependsOn ids to step numbers in plan order and skips unknown ids', () => {
    const plan = [task('ui', 'Build the UI', ['api', 'ghost', 'schema']), task('schema', 'Add the schema'), task('api', 'Expose the API', ['schema'])];
    const prerequisites = resolveTaskPrerequisites(plan);
    expect(prerequisites.get('ui')).toEqual([
      { id: 'schema', stepNumber: 2, title: 'Add the schema' },
      { id: 'api', stepNumber: 3, title: 'Expose the API' },
    ]);
    expect(prerequisites.get('schema')).toEqual([]);
  });

  it('shows the steps a task depends on, and nothing for an independent task', () => {
    const { container, rerender } = render(<TaskPrerequisites prerequisites={[{ id: 'schema', stepNumber: 2, title: 'Add the schema' }]} />);
    expect(screen.getByText('Depends on')).toBeTruthy();
    expect(screen.getByText('2. Add the schema')).toBeTruthy();
    rerender(<TaskPrerequisites prerequisites={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
