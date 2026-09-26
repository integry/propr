import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { localProfile } from './DesktopExperience.testSupport';
import type { DesktopGuidedLocalSetupAdapter } from './types';

export const idle: DesktopSetupSnapshot = {
  phase: 'idle', capability: { supported: true, kind: 'local', platform: 'linux' },
  sessionId: '11111111-1111-4111-8111-111111111111', logs: [],
};

export const completed: DesktopSetupSnapshot = {
  ...idle, phase: 'completed', profile: { ...localProfile, kind: 'local' },
};

const defaultCancelled: DesktopSetupSnapshot = {
  ...idle, phase: 'cancelled', error: 'Setup was cancelled safely.',
};

export const guidedAdapter = (
  overrides: Partial<DesktopGuidedLocalSetupAdapter> = {},
): DesktopGuidedLocalSetupAdapter => ({
  supported: true,
  status: vi.fn(async () => idle),
  start: vi.fn(async () => completed),
  retry: vi.fn(async () => completed),
  cancel: vi.fn(async () => defaultCancelled),
  selectPrivateKey: vi.fn(async () => null),
  acquireWebhookSecret: vi.fn(async () => null),
  resolveGithubInstallation: vi.fn(async () => idle),
  onProgress: vi.fn(() => () => undefined),
  ...overrides,
});

export const openAndSubmitWizard = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Set up this computer/i }));
  await screen.findByRole('heading', { name: 'Check the essentials' });
  for (const heading of ['Private local storage', 'Connect GitHub', 'GitHub event intake', 'Select coding agents', 'Ready to install']) {
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: heading });
  }
  fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
};
