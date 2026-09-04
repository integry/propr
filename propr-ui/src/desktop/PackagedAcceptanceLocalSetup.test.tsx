import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PackagedAcceptanceLocalSetup,
  packagedAcceptanceSetupSurface,
} from './PackagedAcceptanceLocalSetup';

const acceptanceBridge = { setZoomFactor: vi.fn() };

describe('packaged acceptance local-setup surfaces', () => {
  afterEach(() => {
    cleanup();
    delete window.__PROPR_PACKAGED_ACCEPTANCE__;
    delete window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__;
  });

  it('is available only through the main-attested acceptance bridge', () => {
    expect(packagedAcceptanceSetupSurface()).toBeNull();
    window.__PROPR_PACKAGED_ACCEPTANCE__ = acceptanceBridge;
    expect(packagedAcceptanceSetupSurface()).toBe('prerequisites');
    window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ = 'setup-error';
    expect(packagedAcceptanceSetupSurface()).toBe('error');
    window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ = 'setup-complete';
    expect(packagedAcceptanceSetupSurface()).toBe('completion');
  });

  it('drives the fixed prerequisites into the stable progress surface', () => {
    render(<PackagedAcceptanceLocalSetup initial="prerequisites" onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Check the essentials' })).toBeInTheDocument();
    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Install ProPR' }));
    expect(screen.getByRole('heading', { name: 'Setting up ProPR' })).toBeInTheDocument();
  });

  it('renders the deterministic recovery and completion states', () => {
    const { rerender } = render(<PackagedAcceptanceLocalSetup initial="error" onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Setup needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('local prerequisites need attention');

    rerender(<PackagedAcceptanceLocalSetup initial="completion" onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Local services are healthy');
  });
});
