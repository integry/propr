import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UsageTipsSettingsSection } from './UsageTipsSettingsSection';
import { parseLoadedData } from './parseLoadedData';

it('shows the toggle and the fixed dismissal cooldown without a cooldown setting', () => {
  const onChange = vi.fn(); const onBlur = vi.fn();
  render(<UsageTipsSettingsSection settings={{}} onChange={onChange} onBlur={onBlur} />);
  const toggle = screen.getByLabelText('Show usage tips');
  expect(toggle).toBeChecked();
  expect(screen.queryByLabelText('Dismissal cooldown days')).not.toBeInTheDocument();
  expect(screen.getByText(/dismissed tip stays hidden for 45 days/)).toBeInTheDocument();
  fireEvent.click(toggle); fireEvent.blur(toggle);
  expect(onChange).toHaveBeenCalledOnce(); expect(onBlur).toHaveBeenCalledOnce();
});
it('loads the persisted setting and defaults a missing one', () => {
  const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
  expect(load({})).toMatchObject({ usage_tips_enabled: true });
  expect(load({ usage_tips_enabled: false })).toMatchObject({ usage_tips_enabled: false });
});
