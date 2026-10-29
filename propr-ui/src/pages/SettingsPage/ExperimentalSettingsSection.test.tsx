import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../api/proprTypes';
import { AuthProvider } from '../../contexts/AuthContext';
import * as runtimeMode from '../../config/runtimeMode';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(), updateSettings: vi.fn(),
  getFollowupKeywords: vi.fn(), updateFollowupKeywords: vi.fn(),
  getFollowupIgnoreKeywords: vi.fn(), updateFollowupIgnoreKeywords: vi.fn(),
  getPrLabel: vi.fn(), updatePrLabel: vi.fn(),
  getPrimaryProcessingLabels: vi.fn(), updatePrimaryProcessingLabels: vi.fn(),
  getAgents: vi.fn(), getInstanceCatalog: vi.fn(),
  getSummarizationSettings: vi.fn(), updateSummarizationSettings: vi.fn(),
  triggerReindexAll: vi.fn(),
}));
vi.mock('../../api/proprApi', () => apiMocks);
vi.mock('../../api/revertApi', () => ({
  getAgentTankSettings: vi.fn(async () => ({ mode: 'disabled', enabled: false, url: '' })),
  getAgentTankStatus: vi.fn(), updateAgentTankSettings: vi.fn(),
}));

import ExperimentalSettingsSection from './ExperimentalSettingsSection';
import SettingsNavigation from './SettingsNavigation';
import { parseLoadedData } from './parseLoadedData';
import { useSettingsState } from './useSettingsState';

const user = { id: 'account-a', username: 'example', permissions: [] } as unknown as CurrentUser;
const Wrapper = ({ children }: { children: ReactNode }) => <AuthProvider user={user}>{children}</AuthProvider>;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(runtimeMode, 'isDesktopRuntime').mockReturnValue(false);
  apiMocks.getSettings.mockResolvedValue({ worker_concurrency: 4 });
  for (const read of [apiMocks.getFollowupKeywords, apiMocks.getFollowupIgnoreKeywords, apiMocks.getPrimaryProcessingLabels]) {
    read.mockResolvedValue([]);
  }
  apiMocks.getPrLabel.mockResolvedValue('AI');
  apiMocks.getAgents.mockResolvedValue([]);
  apiMocks.getInstanceCatalog.mockResolvedValue({ agents: [], repositories: [] });
  apiMocks.getSummarizationSettings.mockResolvedValue({ enabled: false, agent_alias: '' });
  apiMocks.updateSettings.mockResolvedValue({ success: true });
});
afterEach(() => vi.restoreAllMocks());

describe('ExperimentalSettingsSection', () => {
  it('groups voice briefings and dashboard AI summaries under one Experimental heading', () => {
    const onChange = vi.fn();
    render(<ExperimentalSettingsSection dashboardSummaryEnabled={false} onDashboardSummaryChange={onChange} />, { wrapper: Wrapper });

    const section = screen.getByRole('region', { name: 'Experimental' });
    expect(within(section).getByRole('checkbox', { name: 'Enable voice briefings' })).not.toBeChecked();
    const summary = within(section).getByRole('checkbox', { name: 'Dashboard AI summaries' });
    expect(summary).not.toBeChecked();
    expect(within(section).getByText(/summarization model/)).toHaveTextContent(/LLM call/);

    fireEvent.click(summary);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it.each(['experimental', 'dashboard summary', 'voice'])('is found by a settings search for %j', query => {
    render(
      <SettingsNavigation sections={[{
        id: 'experimental',
        category: 'general',
        searchText: 'experimental features opt-in voice briefings dashboard AI summary summaries',
        content: <ExperimentalSettingsSection dashboardSummaryEnabled onDashboardSummaryChange={vi.fn()} />,
      }]} />,
      { wrapper: Wrapper },
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: query } });
    expect(screen.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Dashboard AI summaries' })).toBeChecked();
  });
});

describe('dashboard AI summaries setting', () => {
  it('loads off unless the server reports an explicit opt-in', () => {
    const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
    expect(load({})).toMatchObject({ dashboard_summary_enabled: false });
    expect(load({ dashboard_summary_enabled: false })).toMatchObject({ dashboard_summary_enabled: false });
    expect(load({ dashboard_summary_enabled: true })).toMatchObject({ dashboard_summary_enabled: true });
  });

  it('is never written by an unrelated settings save, only by its own toggle', async () => {
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings.dashboard_summary_enabled).toBe(false);

    act(() => { result.current.triggerSettingsSave(); });
    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledTimes(1));
    expect(apiMocks.updateSettings.mock.calls[0][0]).not.toHaveProperty('dashboard_summary_enabled');

    await act(async () => { await result.current.handleDashboardSummaryChange(true); });
    expect(apiMocks.updateSettings).toHaveBeenLastCalledWith({ dashboard_summary_enabled: true });
    expect(result.current.settings.dashboard_summary_enabled).toBe(true);
  });
});
