import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  detectAgentTank: vi.fn(),
  enableAgentTank: vi.fn(),
}));

vi.mock('../api/revertApi', () => apiMocks);

import AgentTankDetectionBanner from './AgentTankDetectionBanner';

beforeEach(() => {
  sessionStorage.clear();
  apiMocks.detectAgentTank.mockReset();
  apiMocks.enableAgentTank.mockReset().mockResolvedValue({ success: true });
});

describe('AgentTankDetectionBanner', () => {
  test('offers the mode a mode-aware backend suggests', async () => {
    apiMocks.detectAgentTank.mockResolvedValue({ detected: true, mode: 'bundled' });

    render(<AgentTankDetectionBanner />);

    expect(await screen.findByText('Track Your LLM Usage Limits')).toBeInTheDocument();
  });

  test('a pre-mode backend gets its external offer, never a bundled one', async () => {
    // An older backend answers detection with `{ detected, url }` and no mode.
    // It can only ever have found a daemon, and it cannot store bundled mode at
    // all - so reading its silence as "bundled" would offer a change it would
    // persist as something else.
    apiMocks.detectAgentTank.mockResolvedValue({ detected: true, url: 'http://host.docker.internal:3456' });

    render(<AgentTankDetectionBanner />);

    expect(await screen.findByText('Agent Tank Detected')).toBeInTheDocument();
    expect(screen.queryByText('Track Your LLM Usage Limits')).toBeNull();
  });

  test('a pre-mode backend with nothing detected offers nothing', async () => {
    apiMocks.detectAgentTank.mockResolvedValue({ detected: true });

    const { container } = render(<AgentTankDetectionBanner />);

    await waitFor(() => expect(apiMocks.detectAgentTank).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
