import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';
import type { HistoryItem } from './types';

const at = (second: number) => new Date(Date.UTC(2026, 9, 5, 23, 30, second)).toISOString();
const unblockUrl = 'https://github.com/integry/propr/security/secret-scanning/unblock-secret/2Mf8bjCnMb7BJFkLxmEB';

const failedPush: HistoryItem = {
  state: 'FAILED',
  timestamp: at(9),
  reason: 'Task failed: Push of branch 2736/fix was rejected (push_protection)',
  metadata: {
    pushFailure: {
      diagnosis: { classification: 'push_protection', summary: 'GitHub secret scanning push protection blocked the push.', unblockUrls: [unblockUrl] },
      rung: 'rescue_ref',
      branchName: '2736/fix',
      repository: 'integry/propr',
      rescueRef: 'refs/propr/rescue/task-1',
      recoveryInstruction: 'The commits were pushed to `refs/propr/rescue/task-1` on integry/propr.',
    },
  },
};

describe('Push failure diagnosis on the task timeline', () => {
  for (const variant of ['rail', 'branch'] as const) {
    it(`shows the classification, unblock URL and recovery (${variant})`, () => {
      render(<TaskStatusTable variant={variant} history={[{ state: 'POST_PROCESSING', timestamp: at(1) }, failedPush]} />);
      expect(screen.getByTestId('push-failure')).toHaveTextContent('Push rejected: Secret scanning push protection');
      expect(screen.getByRole('link', { name: unblockUrl })).toHaveAttribute('href', unblockUrl);
      expect(screen.getByTestId('push-failure-recovery')).toHaveTextContent('refs/propr/rescue/task-1');
    });
  }

  it('keeps literal backticks of a branch name inside the recovery command', () => {
    const recoveryInstruction = "The commits were pushed to `refs/propr/rescue/task-1` on integry/propr. Recover them with: ``git fetch origin refs/propr/rescue/task-1 && git checkout -B 'fix`id' FETCH_HEAD``, then push the branch.";
    render(<TaskStatusTable history={[{ ...failedPush, metadata: { pushFailure: { ...failedPush.metadata!.pushFailure!, branchName: 'fix`id', recoveryInstruction } } }]} />);
    const codes = Array.from(screen.getByTestId('push-failure-recovery').querySelectorAll('code')).map(code => code.textContent);
    expect(codes).toEqual(['refs/propr/rescue/task-1', "git fetch origin refs/propr/rescue/task-1 && git checkout -B 'fix`id' FETCH_HEAD"]);
  });

  it('labels a recovered push with its salvage summary once', () => {
    const summary = 'Push succeeded after refreshing the git credential';
    render(<TaskStatusTable history={[
      { state: 'POST_PROCESSING', timestamp: at(1) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(2), reason: summary, metadata: { description: summary, pushSalvage: { rung: 'retry', classification: 'auth', summary } } },
    ]} />);
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.queryByTestId('push-failure')).not.toBeInTheDocument();
  });
});
