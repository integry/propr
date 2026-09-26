import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PREVIEW_STORAGE_V1_DEFAULTS, type ManagedPreviewStorageStatus } from '@propr/shared';
import ManagedPreviewStorageSection from './ManagedPreviewStorageSection';
import { getManagedPreviewStorageStatus } from '../../api/previewStorageApi';
vi.mock('../../api/previewStorageApi', () => ({ getManagedPreviewStorageStatus: vi.fn() }));
const getStatus = vi.mocked(getManagedPreviewStorageStatus);
const enabled: ManagedPreviewStorageStatus = {
  version: 1, state: 'enabled', enabled: true,
  effective: {
    version: 1, installationId: 42, enabled: true, ...PREVIEW_STORAGE_V1_DEFAULTS,
    quotaBytes: 40 * 1024 ** 3, maxObjectBytes: 250 * 1024 ** 2, retentionDays: 30,
    usedBytes: 0, reservedBytes: 0, allowedContentTypes: ['image/png'], deleteSupported: false,
  },
};
describe('managed preview storage settings', () => {
  beforeEach(() => vi.resetAllMocks());
  it('displays effective values supplied by Connect', async () => {
    getStatus.mockResolvedValue(enabled);
    render(<ManagedPreviewStorageSection />);
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    for (const value of ['40 GiB', '250 MiB', '30 days']) expect(screen.getByText(value)).toBeInTheDocument();
    expect(screen.queryByText('25 GiB')).not.toBeInTheDocument();
  });
  for (const [state, label] of [['plus_required', 'Plus required'], ['unavailable', 'Unavailable']] as const) {
    it(`shows ${state} with an explicit GitHub fallback and labeled defaults`, async () => {
      getStatus.mockResolvedValue({ version: 1, state, enabled: false, effective: null });
      render(<ManagedPreviewStorageSection />);
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.getByText(/through GitHub/)).toBeInTheDocument();
      for (const value of ['25 GiB', '500 MiB', '90 days']) expect(screen.getByText(value)).toBeInTheDocument();
      expect(screen.getByText(/Standard Plus limits shown/)).toBeInTheDocument();
    });
  }
  it('refreshes a server-disabled status when Connect becomes enabled', async () => {
    getStatus.mockResolvedValueOnce({ ...enabled, enabled: false, state: 'disabled', effective: { ...enabled.effective!, enabled: false } }).mockResolvedValueOnce(enabled);
    render(<ManagedPreviewStorageSection />);
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
  });
});
