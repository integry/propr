import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UsageTipsSettingsSection } from './UsageTipsSettingsSection';
import { parseLoadedData } from './parseLoadedData';

it('shows shared defaults, limits and existing-dismissal recalculation guidance', () => {
  const onChange = vi.fn(); const onBlur = vi.fn();
  render(<UsageTipsSettingsSection settings={{}} onChange={onChange} onBlur={onBlur} />);
  expect(screen.getByLabelText('Show usage tips')).toBeChecked();
  const cooldown = screen.getByLabelText('Dismissal cooldown days');
  expect(cooldown).toHaveValue(45); expect(cooldown).toHaveAttribute('min', '1'); expect(cooldown).toHaveAttribute('max', '365');
  expect(screen.getByText(/recalculates existing cooldowns/)).toBeInTheDocument();
  fireEvent.change(cooldown, { target: { value: '60' } }); fireEvent.blur(cooldown);
  expect(onChange).toHaveBeenCalledOnce(); expect(onBlur).toHaveBeenCalledOnce();
});
it('loads both persisted settings and defaults missing ones', () => {
  const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
  expect(load({})).toMatchObject({ usage_tips_enabled: true, usage_tips_dismissal_cooldown_days: 45 });
  expect(load({ usage_tips_enabled: false, usage_tips_dismissal_cooldown_days: 90 })).toMatchObject({ usage_tips_enabled: false, usage_tips_dismissal_cooldown_days: 90 });
});
