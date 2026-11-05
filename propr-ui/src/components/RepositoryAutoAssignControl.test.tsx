import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryAutoAssignControl } from './RepositoryAutoAssignControl';

const repo: MonitoredRepo = { id: 'repo-1', name: 'integry/propr', enabled: true };
const toggleName = 'Assign pull requests for integry/propr';
const loginName = 'Default assignee for integry/propr';
const reviewName = 'Request a review from the assignee for integry/propr';

const renderControl = (overrides: Partial<MonitoredRepo> = {}, isReadOnly = false) => {
  const handlers = { onToggle: vi.fn(), onUpdateTarget: vi.fn(), onToggleReview: vi.fn() };
  render(<RepositoryAutoAssignControl repo={{ ...repo, ...overrides }} {...handlers} isReadOnly={isReadOnly} />);
  return handlers;
};

describe('RepositoryAutoAssignControl', () => {
  it('is off by default and hides the assignee and review options', () => {
    const handlers = renderControl();
    const toggle = screen.getByRole('checkbox', { name: toggleName }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByRole('textbox', { name: loginName })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: reviewName })).toBeNull();

    fireEvent.click(toggle);
    expect(handlers.onToggle).toHaveBeenCalledWith('repo-1');
  });

  it('commits the login on blur, not on every keystroke', () => {
    const handlers = renderControl({ autoAssignPullRequests: true });
    expect(screen.getByText('Empty, so the author of the issue is assigned. Bot authors are skipped.')).toBeTruthy();
    const login = screen.getByRole('textbox', { name: loginName });

    fireEvent.change(login, { target: { value: '@octo' } });
    fireEvent.change(login, { target: { value: '@octocat' } });
    expect(handlers.onUpdateTarget).not.toHaveBeenCalled();
    fireEvent.blur(login);
    expect(handlers.onUpdateTarget).toHaveBeenCalledOnce();
    expect(handlers.onUpdateTarget).toHaveBeenCalledWith('repo-1', 'octocat');
  });

  it('clears the login to null and skips an unchanged value', () => {
    const handlers = renderControl({ autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat' });
    const login = screen.getByRole('textbox', { name: loginName });
    fireEvent.blur(login);
    expect(handlers.onUpdateTarget).not.toHaveBeenCalled();

    fireEvent.change(login, { target: { value: '  ' } });
    fireEvent.keyDown(login, { key: 'Enter' });
    fireEvent.blur(login);
    expect(handlers.onUpdateTarget).toHaveBeenCalledWith('repo-1', null);
  });

  it('reports an invalid login inline without saving it', () => {
    const handlers = renderControl({ autoAssignPullRequests: true });
    const login = screen.getByRole('textbox', { name: loginName });
    fireEvent.change(login, { target: { value: 'not a login' } });
    fireEvent.blur(login);
    expect(login.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Changes have not been saved.');
    expect(handlers.onUpdateTarget).not.toHaveBeenCalled();
  });

  it('toggles the review request independently', () => {
    const handlers = renderControl({ autoAssignPullRequests: true });
    fireEvent.click(screen.getByRole('checkbox', { name: reviewName }));
    expect(handlers.onToggleReview).toHaveBeenCalledWith('repo-1');
    expect(handlers.onToggle).not.toHaveBeenCalled();
  });

  it('disables every input and writes nothing when read-only', () => {
    const handlers = renderControl({ autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat' }, true);
    const inputs = [toggleName, reviewName].map(name => screen.getByRole('checkbox', { name }) as HTMLInputElement);
    const login = screen.getByRole('textbox', { name: loginName }) as HTMLInputElement;
    for (const input of [...inputs, login]) expect(input.disabled).toBe(true);

    for (const input of inputs) fireEvent.click(input);
    fireEvent.change(login, { target: { value: 'hubot' } });
    fireEvent.blur(login);
    expect(handlers.onToggle).not.toHaveBeenCalled();
    expect(handlers.onToggleReview).not.toHaveBeenCalled();
    expect(handlers.onUpdateTarget).not.toHaveBeenCalled();
  });
});
