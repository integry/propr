import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, updateSettings } from './configApi';
import { addToTriggerWhitelist, isLoginInWhitelist, removeFromTriggerWhitelist } from './triggerWhitelistApi';

vi.mock('./configApi', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn()
}));

const mockGetSettings = vi.mocked(getSettings);
const mockUpdateSettings = vi.mocked(updateSettings);

describe('triggerWhitelistApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSettings.mockResolvedValue({ success: true });
  });

  it('matches GitHub logins case-insensitively', () => {
    expect(isLoginInWhitelist(['Developer'], 'developer')).toBe(true);
    expect(isLoginInWhitelist(['owner'], 'developer')).toBe(false);
  });

  it('appends a login to the current whitelist', async () => {
    mockGetSettings.mockResolvedValue({ github_user_whitelist: ['owner'] } as never);

    await expect(addToTriggerWhitelist('developer')).resolves.toEqual(['owner', 'developer']);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { github_user_whitelist: ['owner', 'developer'] },
      // Matches the server's configRevision() over the effective whitelist.
      { expectedRevision: createHash('sha256').update(JSON.stringify(['owner'])).digest('hex') }
    );
  });

  it('does not write when the login is already listed', async () => {
    mockGetSettings.mockResolvedValue({ github_user_whitelist: ['owner', 'Developer'] } as never);

    await expect(addToTriggerWhitelist('developer')).resolves.toEqual(['owner', 'Developer']);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('removes a login without touching other entries', async () => {
    mockGetSettings.mockResolvedValue({ github_user_whitelist: ['owner', 'Developer', 'bot[bot]'] } as never);

    await expect(removeFromTriggerWhitelist('developer')).resolves.toEqual(['owner', 'bot[bot]']);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { github_user_whitelist: ['owner', 'bot[bot]'] },
      expect.objectContaining({})
    );
  });

  it('refuses to remove the final entry, which would open trigger access', async () => {
    mockGetSettings.mockResolvedValue({ github_user_whitelist: ['developer'] } as never);

    await expect(removeFromTriggerWhitelist('developer')).rejects.toThrow(/open trigger access/);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('refuses to add when the whitelist was cleared after the offer, which would restrict open access', async () => {
    mockGetSettings.mockResolvedValue({ github_user_whitelist: [] } as never);

    await expect(addToTriggerWhitelist('developer')).rejects.toThrow(/whitelist is now empty/);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  describe('without secure hashing', () => {
    beforeEach(() => {
      vi.stubGlobal('crypto', {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('never posts an unguarded addition', async () => {
      mockGetSettings.mockResolvedValue({ github_user_whitelist: ['owner'] } as never);

      await expect(addToTriggerWhitelist('developer')).rejects.toThrow(/secure hashing is unavailable/);
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('never posts an unguarded removal', async () => {
      mockGetSettings.mockResolvedValue({ github_user_whitelist: ['owner', 'developer'] } as never);

      await expect(removeFromTriggerWhitelist('developer')).rejects.toThrow(/secure hashing is unavailable/);
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });
  });
});
