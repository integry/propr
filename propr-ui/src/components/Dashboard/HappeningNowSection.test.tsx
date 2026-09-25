/**
 * Running rows carry a live sub-phase, not a spinner.
 *
 * A row that shows only a title and a ticking timer cannot tell a working
 * agent from a hung one. Every running row therefore says what the run is
 * doing right now, and — where the agent's stream shows it — how far through
 * its own plan it is and when it last produced output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HappeningNowSection from './HappeningNowSection';
import { getDashboardActive } from '../../api/dashboardApi';
import { activeItem, activeResponse } from '../Dashboard.fixtures';

vi.mock('../../api/dashboardApi', () => ({ getDashboardActive: vi.fn() }));

const mockActive = vi.mocked(getDashboardActive);
const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

async function renderRows(): Promise<HTMLElement[]> {
  render(
    <MemoryRouter>
      <HappeningNowSection repository="all" refreshToken={0} />
    </MemoryRouter>,
  );
  const list = await screen.findByTestId('happening-now-list');
  return within(list).getAllByRole('listitem');
}

const subPhase = (row: HTMLElement): HTMLElement => within(row).getByTestId('running-sub-phase');

describe('Happening now sub-phase line', () => {
  beforeEach(() => mockActive.mockReset());

  it('gives every running row a sub-phase line, and none of them a spinner', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ id: 'a', taskId: 'a', progressLine: 'Running tests' }),
      activeItem({ id: 'b', taskId: 'b', progressLine: null, activity: 'Editing Dashboard.tsx' }),
      activeItem({ id: 'c', taskId: 'c', progressLine: null, activity: null }),
      activeItem({ id: 'd', taskId: 'd', state: 'processing', phase: 'Preparing', progressLine: null }),
      activeItem({ id: 'e', taskId: 'e', state: 'post_processing', phase: 'Finishing up', progressLine: null, activity: 'Running npm test' }),
    ]));

    const rows = await renderRows();

    expect(rows.map(row => subPhase(row).querySelector('.sm\\:inline')?.textContent)).toEqual([
      'Running tests',
      'Editing Dashboard.tsx',
      'Waiting for the agent\'s first output',
      'Setting up the workspace',
      // Once the agent has finished, its last tool call is history, not the phase.
      'Publishing the results',
    ]);
    const section = screen.getByTestId('happening-now-section');
    expect(section.querySelector('.animate-spin, .animate-pulse')).toBeNull();
    // The pane and the type badge already say the work is being implemented.
    expect(section.textContent).not.toContain('Implementing');
  });

  it('pins the plan step and the time since the agent last produced output to the end of the line', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({
        progressLine: 'Running tests',
        activity: 'Running npx vitest run',
        step: { current: 3, total: 7 },
        lastActivityAt: secondsAgo(12),
      }),
      activeItem({
        id: 'quiet',
        taskId: 'quiet',
        progressLine: null,
        activity: 'Editing retry.ts',
        step: null,
        lastActivityAt: secondsAgo(18 * 60),
      }),
    ]));

    const [live, quiet] = await renderRows();

    expect(within(live).getByTestId('running-step')).toHaveTextContent('step 3/7');
    expect(within(live).getByTestId('running-last-output')).toHaveTextContent('last output just now');
    // The plan step leads the line; the concrete action is one hover away.
    expect(within(live).getByText('Running tests', { selector: '.sm\\:inline' }))
      .toHaveAttribute('title', 'Latest action: Running npx vitest run');

    // A quiet agent is not called stalled: the row states the fact and leaves
    // the judgement to the reader.
    expect(within(quiet).queryByTestId('running-step')).toBeNull();
    expect(within(quiet).getByTestId('running-last-output')).toHaveTextContent('last output 18 mins ago');
    expect(quiet.textContent).not.toMatch(/stalled|stuck|hung/i);
  });

  it('shows no freshness for phases in which the agent is not the one running', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ state: 'post_processing', phase: 'Finishing up', progressLine: null, step: { current: 7, total: 7 }, lastActivityAt: secondsAgo(40) }),
    ]));

    const [row] = await renderRows();

    expect(within(row).queryByTestId('running-step')).toBeNull();
    expect(within(row).queryByTestId('running-last-output')).toBeNull();
  });
});
