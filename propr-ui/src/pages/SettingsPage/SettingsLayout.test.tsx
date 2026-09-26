import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsCheckboxField, SettingsField, SettingsSection, SettingsStatus } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

describe('Settings layout primitives', () => {
  it('titles a section with a utility header over a 1px divider, without a card', () => {
    const { container } = render(
      <SettingsSection title="Planning models" description="Models used while planning.">
        <p>Body</p>
      </SettingsSection>
    );

    const heading = screen.getByRole('heading', { name: 'Planning models' });
    expect(heading).toHaveClass('text-[11px]', 'font-bold', 'uppercase', 'tracking-widest', 'text-slate-500');
    expect(heading.parentElement).toHaveClass('border-b', 'border-slate-200');
    expect(container.querySelector('section')).not.toHaveClass('rounded-lg', 'border', 'shadow-sm');
    expect(screen.getByRole('region', { name: 'Planning models' })).toBeInTheDocument();
  });

  it('stacks label, control, and helper text in one readable column', () => {
    render(
      <SettingsField label="Plan Generation Model" htmlFor="plan-model" helperText="Used for plans.">
        <select id="plan-model" className={SETTINGS_CONTROL}><option>gpt</option></select>
      </SettingsField>
    );

    const control = screen.getByLabelText('Plan Generation Model');
    const row = control.closest('div')?.parentElement;
    expect(row).toHaveClass('max-w-2xl');
    expect(control).toHaveClass('w-full');
    // Label precedes the control, helper text follows it.
    expect(row?.firstElementChild?.tagName).toBe('LABEL');
    expect(row?.lastElementChild).toHaveTextContent('Used for plans.');
  });

  it('puts the checkbox left of a stacked label and helper text', () => {
    render(
      <SettingsCheckboxField
        id="gather"
        label="Gather related unchanged code"
        helperText="Scout failure never blocks the review."
        checked
        onChange={() => undefined}
      />
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Gather related unchanged code' });
    expect(checkbox.parentElement).toHaveClass('flex', 'items-start', 'gap-3');
    expect(checkbox.parentElement?.firstElementChild).toBe(checkbox);
    const labelColumn = checkbox.parentElement?.querySelector('div');
    expect(labelColumn).toContainElement(screen.getByText('Gather related unchanged code'));
    expect(labelColumn).toContainElement(screen.getByText('Scout failure never blocks the review.'));
  });

  it('reports success quietly with a teal dot and neutral text', () => {
    render(<SettingsStatus tone="ok">Agent Tank connected</SettingsStatus>);

    const status = screen.getByText('Agent Tank connected');
    expect(status).toHaveClass('text-slate-500');
    expect(status).not.toHaveClass('text-green-700');
    expect(status.querySelector('span')).toHaveClass('h-2', 'w-2', 'rounded-full', 'bg-teal-500');
  });
});
