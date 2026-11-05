import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TasksBeingCreated } from './PlanIssuesManagerToolbar';
import { IDLE_PROGRESS, withCreatedIssues, type IssueCreationProgress } from './planIssuesManagerUtils';
import type { PlanTask } from '../../api/plannerApi';

const tasks = Array.from({ length: 8 }, (_, index) => ({ id: `t${index}`, title: `Task ${index + 1}` })) as PlanTask[];
const event = (createdCount: number, failedCount: number, number: number, title: string): IssueCreationProgress => ({
  status: 'in_progress', createdCount, totalCount: tasks.length, failedCount,
  lastCreatedIssue: { number, url: `https://github.com/o/r/issues/${number}`, title },
});
const issueLinks = () => screen.getAllByTestId('issue-creation-row').map(row => row.querySelector('a')?.textContent ?? null);

describe('TasksBeingCreated issue links', () => {
  it('links only the task a mid-run event names after reconnecting', () => {
    // The first event this client receives already reports six created issues.
    const progress = withCreatedIssues(event(6, 0, 2905, 'Task 6'), IDLE_PROGRESS);
    render(<TasksBeingCreated tasks={tasks} issueCreationProgress={progress} />);

    expect(issueLinks()).toEqual([null, null, null, null, null, '#2905', null, null]);
  });

  it('places an issue on its own task when an earlier task failed', () => {
    let progress = withCreatedIssues(event(1, 0, 2900, 'Task 1'), IDLE_PROGRESS);
    // Task 2 failed, so the second created issue belongs to task 3.
    progress = withCreatedIssues(event(2, 1, 2901, 'Task 3'), progress);
    render(<TasksBeingCreated tasks={tasks} issueCreationProgress={progress} />);

    expect(issueLinks().slice(0, 3)).toEqual(['#2900', null, '#2901']);
  });

  it('prefers the persisted issue link over received events', () => {
    const persisted = tasks.map((task, index) => (index === 0 ? { ...task, issue_number: 2800, issue_url: 'https://github.com/o/r/issues/2800' } : task));
    const progress = withCreatedIssues(event(2, 0, 2801, 'Task 2'), IDLE_PROGRESS);
    render(<TasksBeingCreated tasks={persisted} issueCreationProgress={progress} />);

    expect(issueLinks().slice(0, 3)).toEqual(['#2800', '#2801', null]);
  });
});
