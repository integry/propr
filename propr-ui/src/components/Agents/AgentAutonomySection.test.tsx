import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentAutonomySection } from './AgentAutonomySection';

describe('AgentAutonomySection', () => {
  afterEach(cleanup);

  // Native radios sharing a name give the group one Tab stop and arrow-key selection; e2e/automations.pw.ts drives the keys in a real browser.
  it('renders the segments as one native radio group', () => {
    render(<AgentAutonomySection autonomy="preview" onChange={vi.fn()} actingAvailable disabled={false} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map(radio => radio.getAttribute('value'))).toEqual(['dry_run', 'preview', 'auto']);
    for (const radio of radios) {
      expect(radio.tagName).toBe('INPUT');
      expect(radio).toHaveAttribute('name', 'agent-autonomy');
      expect(radio).toBeEnabled();
    }
    expect(screen.getByRole('radio', { name: 'Preview & approve' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Preview & approve' })).toHaveAttribute('aria-describedby', 'agent-autonomy-description');
  });

  it('leaves only dry run reachable when acting is unavailable', () => {
    render(<AgentAutonomySection autonomy="dry_run" onChange={vi.fn()} actingAvailable={false} disabled={false} />);
    expect(screen.getByRole('radio', { name: 'Dry run' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Preview & approve' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeDisabled();
  });
});
