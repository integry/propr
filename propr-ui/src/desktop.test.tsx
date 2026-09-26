import { describe, expect, it, vi } from 'vitest';
import type { DesktopProfile } from '../../apps/desktop/src/shared/contract';
import { activateDesktopProfile } from './desktop-profile';

const profile = (id: string, apiBaseUrl: string): DesktopProfile => ({
  id,
  label: id,
  apiBaseUrl,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
});

describe('desktop profile activation', () => {
  it('reloads module state after selecting each distinct API endpoint', async () => {
    const profiles = [
      profile('first', 'https://first.propr.example'),
      profile('second', 'https://second.propr.example'),
    ];
    let activeProfile: DesktopProfile | undefined;
    const loadedEndpoints: string[] = [];
    const setActive = vi.fn(async (profileId: string | null) => {
      activeProfile = profiles.find(item => item.id === profileId);
    });
    const reload = vi.fn(() => {
      if (activeProfile) loadedEndpoints.push(activeProfile.apiBaseUrl);
    });

    await activateDesktopProfile({ setActive }, profiles[0], reload);
    await activateDesktopProfile({ setActive }, profiles[1], reload);

    expect(setActive).toHaveBeenNthCalledWith(1, 'first');
    expect(setActive).toHaveBeenNthCalledWith(2, 'second');
    expect(loadedEndpoints).toEqual([
      'https://first.propr.example',
      'https://second.propr.example',
    ]);
  });
});
