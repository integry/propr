import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AutomationRunRecord } from '../../api/automationDefinitionsApi';
import { AgentEventTriggerSection } from './AgentEventTriggerSection';
import { AgentRunTriggerEvent } from './AgentRunTriggerEvent';
import { emptyAgentForm, eventTriggerFilterLost, formToInput } from './agentEditorForm';
import { runTriggerLabel } from './agentRunPresentation';

const event = {
  type: 'plan.issue_blocked' as const, eventId: 41, repository: 'acme/app', planId: 'plan-1', planName: 'Billing epic',
  executionId: 'exec-1', issueNumber: 12, reasonKind: 'agent_blocked', reason: 'Needs credentials',
  planUrl: 'https://propr.example/studio/plan-1', issueUrl: 'https://github.com/acme/app/issues/12', occurredAt: Date.UTC(2026, 10, 13),
};

describe('automation event trigger', () => {
  afterEach(cleanup);

  it('is off by default and sends no subscription', () => {
    expect(formToInput({ ...emptyAgentForm(), name: 'A', prompt: 'B' }).eventTriggers).toEqual([]);
  });

  it('sends the subscription with its filters, kept within the automation repositories', () => {
    const input = formToInput({
      ...emptyAgentForm(), name: 'A', prompt: 'B', repositories: ['acme/app'],
      blockedTrigger: true, blockedTriggerRepositories: ['acme/app', 'acme/removed'], blockedTriggerReasonKinds: ['agent_blocked'],
    });
    expect(input.eventTriggers).toEqual([{ event: 'plan.issue_blocked', repositories: ['acme/app'], reasonKinds: ['agent_blocked'] }]);
  });

  it('never widens a filter whose last repository was removed from the automation', () => {
    // Limited to acme/app; acme/app is removed and acme/api remains.
    const form = {
      ...emptyAgentForm(), name: 'A', prompt: 'B', repositories: ['acme/api'],
      blockedTrigger: true, blockedTriggerRepositories: ['acme/app'], blockedTriggerReasonKinds: [],
    };
    expect(eventTriggerFilterLost(form)).toBe(true);
    // Sent as it was, so the scope check refuses it instead of an empty filter matching acme/api.
    expect(formToInput(form).eventTriggers).toEqual([{ event: 'plan.issue_blocked', repositories: ['acme/app'], reasonKinds: [] }]);
    // An explicit choice is not a lost filter.
    expect(eventTriggerFilterLost({ ...form, blockedTriggerRepositories: [] })).toBe(false);
    expect(eventTriggerFilterLost({ ...form, blockedTriggerRepositories: ['acme/app', 'acme/api'] })).toBe(false);
    expect(eventTriggerFilterLost({ ...form, blockedTrigger: false })).toBe(false);
  });

  it('asks for a new filter when the last limited repository was removed', () => {
    const onChange = vi.fn();
    render(<AgentEventTriggerSection enabled repositories={['acme/app']} reasonKinds={[]} automationRepositories={['acme/api']} onChange={onChange} disabled={false} />);
    expect(screen.getByTestId('agent-event-trigger-filter-lost')).toHaveTextContent('acme/app');
    expect(screen.getByRole('checkbox', { name: 'acme/api' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    expect(onChange).toHaveBeenLastCalledWith({ blockedTriggerRepositories: ['acme/api'] });
    fireEvent.click(screen.getByRole('button', { name: "React to all of this automation's repositories" }));
    expect(onChange).toHaveBeenLastCalledWith({ blockedTriggerRepositories: [] });
  });

  it('turns on and filters by repository and reason', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AgentEventTriggerSection enabled={false} repositories={[]} reasonKinds={[]} automationRepositories={['acme/app', 'acme/api']} onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Plan issue blocked' }));
    expect(onChange).toHaveBeenLastCalledWith({ blockedTrigger: true });

    rerender(<AgentEventTriggerSection enabled repositories={[]} reasonKinds={[]} automationRepositories={['acme/app', 'acme/api']} onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    expect(onChange).toHaveBeenLastCalledWith({ blockedTriggerRepositories: ['acme/api'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agent reported a blocker' }));
    expect(onChange).toHaveBeenLastCalledWith({ blockedTriggerReasonKinds: ['agent_blocked'] });
  });

  it('asks for repositories when the automation has none', () => {
    render(<AgentEventTriggerSection enabled repositories={[]} reasonKinds={[]} automationRepositories={[]} onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId('agent-event-trigger-feedback')).toHaveTextContent('Choose the repositories');
  });

  it('shows which event started a run', () => {
    const run = { trigger: 'event', triggerEvent: event } as Pick<AutomationRunRecord, 'trigger' | 'triggerEvent'>;
    expect(runTriggerLabel(run)).toBe('Issue #12 blocked');
    expect(runTriggerLabel({ trigger: 'schedule', triggerEvent: null })).toBe('Schedule');
    render(<MemoryRouter><AgentRunTriggerEvent run={run} /></MemoryRouter>);
    const panel = screen.getByTestId('agent-run-trigger-event');
    expect(panel).toHaveTextContent('Billing epic');
    expect(panel).toHaveTextContent('Needs credentials');
    expect(screen.getByRole('link', { name: 'Open plan' })).toHaveAttribute('href', '/studio/plan-1');
    expect(screen.getByRole('link', { name: 'Open issue' })).toHaveAttribute('href', event.issueUrl);
  });
});

describe('automation list trigger summary', () => {
  it('names an automation that only reacts to its event', async () => {
    const { scheduleSummary } = await import('./agentPresentation');
    const base = { scheduleCron: null, scheduleEnabled: false, nextRunAt: null, enabled: true };
    expect(scheduleSummary(base, 0)).toBe('Manual');
    expect(scheduleSummary({ ...base, eventTriggers: [{ event: 'plan.issue_blocked', repositories: [], reasonKinds: [] }] }, 0)).toBe('On blocked issue');
  });
});
