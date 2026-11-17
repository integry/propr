import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { getSettings } from '../../api/configApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';
import { useUnproductiveRunThreshold } from './useUnproductiveRunThreshold';
import { AgentScheduleSection } from './AgentScheduleSection';

vi.mock('../../api/configApi', () => ({ getSettings: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: vi.fn(() => null), userHasPermission: vi.fn() }));

const settingsWith = (threshold: unknown) => ({ automation_unproductive_run_threshold: threshold }) as unknown as Awaited<ReturnType<typeof getSettings>>;

describe('useUnproductiveRunThreshold', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names no number to someone who cannot read an instance set to 4 runs', async () => {
    vi.mocked(useCurrentUser).mockReturnValue(null);
    vi.mocked(userHasPermission).mockReturnValue(false);
    vi.mocked(getSettings).mockResolvedValue(settingsWith(4));
    const { result } = renderHook(() => useUnproductiveRunThreshold());
    await Promise.resolve();
    expect(getSettings).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('reads the instance setting for someone who manages settings', async () => {
    vi.mocked(userHasPermission).mockReturnValue(true);
    vi.mocked(getSettings).mockResolvedValue(settingsWith(4));
    const { result } = renderHook(() => useUnproductiveRunThreshold());
    await waitFor(() => expect(result.current).toBe(4));
  });

  it('falls back to the default, as the server does, when the setting holds no usable value', async () => {
    vi.mocked(userHasPermission).mockReturnValue(true);
    vi.mocked(getSettings).mockResolvedValue(settingsWith(undefined));
    const { result } = renderHook(() => useUnproductiveRunThreshold());
    await waitFor(() => expect(result.current).toBe(3));
  });

  it('names no number when the read fails', async () => {
    vi.mocked(userHasPermission).mockReturnValue(true);
    vi.mocked(getSettings).mockRejectedValue(new Error('forbidden'));
    const { result } = renderHook(() => useUnproductiveRunThreshold());
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current).toBeNull();
  });
});

describe('AgentScheduleSection pause label', () => {
  afterEach(cleanup);

  const renderSection = (unproductiveRunThreshold: number | null) => render(
    <AgentScheduleSection enabled expression="0 9 * * *" onChange={vi.fn()} disabled={false} unproductiveRunThreshold={unproductiveRunThreshold} />,
  );

  it('promises no count when the threshold is unknown', () => {
    renderSection(null);
    expect(screen.getByText('Pause the schedule when runs in a row keep finding nothing new')).toBeInTheDocument();
    expect(screen.queryByText(/after \d+ runs/)).not.toBeInTheDocument();
  });

  it('states the configured count when it is known', () => {
    renderSection(4);
    expect(screen.getByText('Pause the schedule after 4 runs in a row with nothing new')).toBeInTheDocument();
  });
});
