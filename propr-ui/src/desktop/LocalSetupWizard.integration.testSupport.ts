import { fireEvent, screen } from '@testing-library/react';
import { expect, vi } from 'vitest';
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

export async function clickAndWaitForHeading(button: string | RegExp, heading: string) {
  fireEvent.click(await screen.findByRole('button', { name: button }));
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
}

export async function continueThrough(...headings: string[]) {
  for (const heading of headings) {
    await clickAndWaitForHeading(/Continue/i, heading);
  }
}

export function installationSnapshot(identity: Partial<NonNullable<DesktopSetupSnapshot['githubIdentity']>> = {}): DesktopSetupSnapshot {
  return {
    ...idle, phase: 'running', githubIdentity: {
      status: 'selection-required', username: 'member-user', installAvailable: true,
      installations: [
        { installationId: '100', accountLogin: 'acme', accountType: 'Organization' },
        { installationId: '200', accountLogin: 'member-user', accountType: 'User' },
      ],
      ...identity,
    },
  };
}
