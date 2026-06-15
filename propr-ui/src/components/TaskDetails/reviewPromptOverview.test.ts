import { describe, expect, it } from 'vitest';
import { formatReviewPromptOverview } from './reviewPromptOverview';

describe('formatReviewPromptOverview', () => {
  it('formats a recognized review payload with all fields', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 123,
      repoOwner: 'owner',
      repoName: 'repo',
      changedFiles: 8,
      diffLines: 1240,
      skippedFiles: 2,
      previousComments: 4,
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #123 in owner/repo. 8 files changed, 1,240 diff lines included, 2 files skipped, 4 previous comments included.'
    );
  });

  it('detects a review payload nested under a prompt wrapper key', () => {
    const payload = JSON.stringify({
      sessionId: 'abc',
      prompt: {
        prNumber: 42,
        repository: 'integry/propr',
        changedFiles: 3,
        diffLines: 100,
      },
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #42 in integry/propr. 3 files changed, 100 diff lines included.'
    );
  });

  it('formats a Claude content-block payload containing review prompt text', () => {
    const payload = JSON.stringify({
      content: [
        {
          type: 'text',
          text: 'You are reviewing pull request #1548 in integry/propr. 8 files changed, 1,240 diff lines included, 2 files skipped, 4 previous comments included.',
        },
      ],
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #1548 in integry/propr. 8 files changed, 1,240 diff lines included, 2 files skipped, 4 previous comments included.'
    );
  });

  it('formats direct review prompt text', () => {
    expect(
      formatReviewPromptOverview('You are reviewing pull request #5 in owner/repo.')
    ).toBe('Reviewing PR #5 in owner/repo.');
  });

  it('lists skipped file names inline when the list is short', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 7,
      repoOwner: 'acme',
      repoName: 'widgets',
      changedFiles: 5,
      skippedFiles: ['a.ts', 'b.ts'],
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #7 in acme/widgets. 5 files changed, 2 files skipped (a.ts, b.ts).'
    );
  });

  it('omits skipped file names when the list is too long to show inline', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 7,
      repoOwner: 'acme',
      repoName: 'widgets',
      skippedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #7 in acme/widgets. 4 files skipped.'
    );
  });

  it('includes optional review instructions/focus', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 99,
      repoOwner: 'owner',
      repoName: 'repo',
      changedFiles: 1,
      instructions: 'Focus on security and error handling',
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #99 in owner/repo. 1 file changed. Review focus: Focus on security and error handling.'
    );
  });

  it('uses singular nouns for counts of one', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 1,
      repoOwner: 'o',
      repoName: 'r',
      changedFiles: 1,
      diffLines: 1,
      skippedFiles: 1,
      previousComments: 1,
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #1 in o/r. 1 file changed, 1 diff line included, 1 file skipped, 1 previous comment included.'
    );
  });

  it('handles snake_case field names', () => {
    const payload = JSON.stringify({
      pull_request_number: 55,
      repo_owner: 'owner',
      repo_name: 'repo',
      changed_files: 2,
      diff_lines: 30,
      previous_comments: 0,
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #55 in owner/repo. 2 files changed, 30 diff lines included.'
    );
  });

  it('extracts the PR number from a nested pullRequest object and repository object', () => {
    const payload = JSON.stringify({
      pullRequest: { number: 321 },
      repository: { owner: { login: 'octo' }, name: 'cat' },
      changedFiles: 4,
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #321 in octo/cat. 4 files changed.'
    );
  });

  it('counts changed/skipped/comment arrays by length', () => {
    const payload = JSON.stringify({
      prNumber: 10,
      repoOwner: 'owner',
      repoName: 'repo',
      files: ['x.ts', 'y.ts', 'z.ts'],
      skippedFiles: [{ filename: 'big.lock' }],
      comments: [{ id: 1 }, { id: 2 }],
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #10 in owner/repo. 3 files changed, 1 file skipped (big.lock), 2 previous comments included.'
    );
  });

  it('omits the location when repository info is missing', () => {
    const payload = JSON.stringify({
      pullRequestNumber: 12,
      changedFiles: 2,
    });

    expect(formatReviewPromptOverview(payload)).toBe(
      'Reviewing PR #12. 2 files changed.'
    );
  });

  it('returns null for non-review JSON (fallback to raw rendering)', () => {
    const payload = JSON.stringify({
      status: 'ok',
      message: 'done',
      count: 5,
    });

    expect(formatReviewPromptOverview(payload)).toBeNull();
  });

  it('returns null for a PR number with no other review signal', () => {
    const payload = JSON.stringify({ number: 5, title: 'Some issue' });
    expect(formatReviewPromptOverview(payload)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(formatReviewPromptOverview('{ not valid json')).toBeNull();
    expect(formatReviewPromptOverview('Review issue #5')).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    expect(formatReviewPromptOverview(null)).toBeNull();
    expect(formatReviewPromptOverview(undefined)).toBeNull();
    expect(formatReviewPromptOverview('')).toBeNull();
    expect(formatReviewPromptOverview('   ')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(formatReviewPromptOverview('[1, 2, 3]')).toBeNull();
  });

  it('truncates very long review instructions', () => {
    const longInstructions = 'a'.repeat(200);
    const payload = JSON.stringify({
      pullRequestNumber: 5,
      repoOwner: 'o',
      repoName: 'r',
      instructions: longInstructions,
    });

    const result = formatReviewPromptOverview(payload);
    expect(result).toContain('Reviewing PR #5 in o/r.');
    expect(result).toContain('Review focus:');
    expect(result).toContain('…');
    // Should not contain the full untruncated instruction string.
    expect(result).not.toContain(longInstructions);
  });
});
