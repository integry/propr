import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import SettingsSaveStatusBar from './SettingsSaveStatusBar';

describe('SettingsSaveStatusBar', () => {
  test('only claims "All changes saved" after a save completes', () => {
    const view = render(<SettingsSaveStatusBar saveStatus="idle" globalError={null} />);
    // A blur-saved field may still be mid-edit while idle, so idle makes no claim.
    expect(screen.getByRole('status')).toHaveTextContent(/^Changes save automatically$/);

    view.rerender(<SettingsSaveStatusBar saveStatus="saved" globalError={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^All changes saved$/);
  });

  test('still reports saving, warnings and errors', () => {
    const view = render(<SettingsSaveStatusBar saveStatus="saving" globalError={null} />);
    expect(screen.getByText('Saving changes...')).toBeInTheDocument();

    view.rerender(<SettingsSaveStatusBar saveStatus="error" globalError="Network down" />);
    expect(screen.getByRole('status')).toHaveTextContent('Network down');
  });
});
