import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import SettingsNavigation, {
  matchesSettingsSearch,
  type SettingsNavigationSection
} from './SettingsNavigation';
import { useSettingsCategoryRoute } from './useSettingsCategoryRoute';

const sections: SettingsNavigationSection[] = [
  {
    id: 'model-selection',
    category: 'models',
    searchText: 'implementation model reasoning',
    content: <p>Model controls</p>
  },
  {
    id: 'merge-rules',
    category: 'workflow',
    searchText: 'automatically resolve merge conflicts',
    content: <p>Merge controls</p>
  },
  {
    id: 'agent-network',
    category: 'sandbox',
    searchText: 'egress proxy allowed hosts',
    content: <p>Network controls</p>
  },
  {
    id: 'usage-tips',
    category: 'general',
    searchText: 'usage tips documentation',
    content: <p>Tip controls</p>
  },
  {
    id: 'visual-previews',
    category: 'integrations',
    searchText: 'GitHub screenshot upload token',
    content: <p>Preview controls</p>
  },
  {
    id: 'personal-notifications',
    category: 'notifications',
    searchText: 'browser push inbox quiet hours timezone',
    content: <p>Notification controls</p>
  }
];

const RoutedSettingsNavigation = () => {
  const categoryRoute = useSettingsCategoryRoute();
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <button type="button" onClick={() => navigate('/settings?flow=desktop&tab=notifications')}>
      Open notification settings
    </button>
    <output data-testid="settings-location">{location.search}</output>
    <SettingsNavigation sections={sections} {...categoryRoute} />
  </>;
};

describe('SettingsNavigation', () => {
  test('lists the settings domains in a vertical rail beside a constrained reading pane', () => {
    const { container } = render(<SettingsNavigation sections={sections} />);

    const rail = screen.getByRole('tablist', { name: 'Settings categories' });
    expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    expect(rail).toHaveClass('flex-col');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'General',
      'AI Models & Reasoning',
      'Workflow & PR Rules',
      'Ultrafix & Escalation',
      'Sandbox & Network',
      'Integrations & MCP',
      'Notifications',
    ]);
    // Rail items carry no count pill: a number beside an item reads as an alert.
    for (const tab of screen.getAllByRole('tab')) expect(tab.textContent).not.toMatch(/\d/);

    const generalTab = screen.getByRole('tab', { name: 'General' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(generalTab).toHaveClass('md:bg-teal-50', 'md:text-teal-700');
    expect(screen.getByText('Tip controls')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toContainElement(
      screen.getByRole('searchbox', { name: 'Search settings' })
    );

    // The reading pane is held to max-w-2xl and blocks stay flat — no card.
    const pane = container.querySelector('[data-settings-pane]');
    expect(pane).toHaveClass('max-w-2xl');
    expect(container.querySelector('[data-settings-section="usage-tips"]')).not.toHaveClass('rounded-lg', 'border', 'shadow-sm');

    // The rail names the open domain, so the pane does not repeat it as a heading.
    expect(screen.queryByRole('heading', { name: 'General' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    expect(screen.getByRole('tab', { name: 'Sandbox & Network' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Network controls')).toBeVisible();
    expect(screen.getByText('Tip controls')).not.toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Sandbox & Network' })).toBeNull();
  });

  test('drills into a category on phones and returns to the category list', () => {
    const { container } = render(<SettingsNavigation sections={sections} header={<h2>Settings</h2>} />);
    const rail = container.querySelector('[data-settings-rail]');
    const pane = container.querySelector('[data-settings-pane]');

    // Screen 1: the category list, each row with a chevron; no form yet.
    expect(rail).not.toHaveClass('hidden');
    expect(pane).toHaveClass('hidden', 'md:block');
    expect(screen.queryByRole('button', { name: 'Back to Settings' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    // Screen 2: the category under a back button; the list and page title step aside.
    expect(rail).toHaveClass('hidden', 'md:flex');
    expect(pane).toHaveClass('block');
    expect(container.querySelector('[data-settings-header]')).toHaveClass('hidden', 'md:block');
    expect(container.querySelector('[data-settings-mobile-header]')).toHaveTextContent('Sandbox & Network');

    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(rail).not.toHaveClass('hidden');
    expect(pane).toHaveClass('hidden');
    expect(screen.getByRole('tab', { name: 'Sandbox & Network' })).toHaveAttribute('aria-selected', 'true');
  });

  test('returns a phone to the category list when its search is cleared', () => {
    const { container } = render(<SettingsNavigation sections={sections} header={<h2>Settings</h2>} />);
    const rail = container.querySelector('[data-settings-rail]');
    // A category was opened earlier, for instance on a wider window.
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'egress' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));
    expect(rail).not.toHaveClass('hidden');
    expect(screen.queryByRole('button', { name: 'Back to Settings' })).toBeNull();
  });

  test('a search started inside a routed category also clears back to the list', () => {
    const { container } = render(<SettingsNavigation sections={sections} activeCategory="notifications" openCategoryOnMobile />);
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'quiet' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: '' } });
    expect(container.querySelector('[data-settings-rail]')).not.toHaveClass('hidden');
    expect(screen.queryByRole('button', { name: 'Back to Settings' })).toBeNull();
  });

  test('announces the opened category outside the rail phones hide', () => {
    const { container } = render(<SettingsNavigation sections={sections} activeCategory="notifications" openCategoryOnMobile />);
    const rail = container.querySelector('[data-settings-rail]');
    expect(rail).toHaveClass('hidden');
    const announcement = container.querySelector('[aria-live="polite"]');
    expect(announcement).toHaveTextContent('Notifications settings selected.');
    expect(rail).not.toContainElement(announcement as HTMLElement);
  });

  test('explains inert controls in the phone category header in demo mode', () => {
    const view = render(<SettingsNavigation sections={sections} activeCategory="workflow" openCategoryOnMobile isReadOnly />);
    expect(view.container.querySelector('[data-settings-mobile-header]')).toHaveTextContent('Demo mode is read-only.');

    view.rerender(<SettingsNavigation sections={sections} activeCategory="workflow" openCategoryOnMobile />);
    expect(view.container.querySelector('[data-settings-mobile-header]')).not.toHaveTextContent('read-only');
  });

  test('opens a routed category directly on phones', () => {
    render(<SettingsNavigation sections={sections} activeCategory="notifications" openCategoryOnMobile />);
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
  });

  test('explains the open category in the inspector, and steps aside for search results', () => {
    render(<SettingsNavigation sections={sections} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    const inspector = screen.getByRole('complementary', { name: 'About Sandbox & Network' });
    expect(inspector).toHaveClass('hidden', '2xl:block');
    expect(inspector).toHaveTextContent('per-run proxy');
    expect(inspector.querySelector('a[href$="#restricted-network-mode"]')).toHaveAttribute('target', '_blank');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'egress' } });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  test('closes every block but the last with its own rule', () => {
    const { container } = render(
      <SettingsNavigation
        sections={[
          { id: 'first', category: 'general', searchText: 'first', content: <p>First</p> },
          { id: 'second', category: 'general', searchText: 'second', content: <p>Second</p> },
        ]}
      />
    );
    expect(container.querySelector('[data-settings-section="first"]')).toHaveClass('mb-8', 'border-b', 'pb-8');
    expect(container.querySelector('[data-settings-section="second"]')).not.toHaveClass('border-b');

    // In search results the last visible block drops the rule, even when a hidden one follows it.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'first' } });
    expect(container.querySelector('[data-settings-section="first"]')).not.toHaveClass('border-b');
  });

  test('moves between rail items with the arrow keys', () => {
    render(<SettingsNavigation sections={sections} />);
    const general = screen.getByRole('tab', { name: 'General' });
    general.focus();

    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'AI Models & Reasoning' })).toHaveFocus();
    expect(screen.getByText('Model controls')).toBeVisible();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'AI Models & Reasoning' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Notifications' }), { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
  });

  test('on phones the arrow keys move through the category list without opening a category', () => {
    const innerWidth = window.innerWidth;
    window.innerWidth = 375;
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/settings']}>
          <RoutedSettingsNavigation />
        </MemoryRouter>
      );
      const rail = container.querySelector('[data-settings-rail]');
      const general = screen.getByRole('tab', { name: 'General' });
      general.focus();

      fireEvent.keyDown(general, { key: 'ArrowDown' });
      const models = screen.getByRole('tab', { name: 'AI Models & Reasoning' });
      expect(models).toHaveFocus();
      expect(rail).not.toHaveClass('hidden');
      expect(screen.getByTestId('settings-location')).toHaveTextContent(/^$/);
      expect(general).toHaveAttribute('aria-selected', 'true');
      // The focused row is the list's Tab stop, so leaving and returning lands on it.
      expect(models).toHaveAttribute('tabindex', '0');
      expect(general).toHaveAttribute('tabindex', '-1');

      fireEvent.keyDown(models, { key: 'ArrowDown' });
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Workflow & PR Rules' }), { key: 'End' });
      const notifications = screen.getByRole('tab', { name: 'Notifications' });
      expect(notifications).toHaveFocus();
      expect(rail).not.toHaveClass('hidden');

      // Enter or Space activates the button, which opens the category and routes to it.
      fireEvent.click(notifications);
      expect(screen.getByTestId('settings-location')).toHaveTextContent('?tab=notifications');
      expect(rail).toHaveClass('hidden');
      expect(container.querySelector('[data-settings-mobile-header]')).toHaveTextContent('Notifications');
    } finally {
      window.innerWidth = innerWidth;
    }
  });

  test('selects a routed category and reports tab changes to routing state', () => {
    const onActiveCategoryChange = vi.fn();
    const view = render(
      <SettingsNavigation
        sections={sections}
        activeCategory="notifications"
        onActiveCategoryChange={onActiveCategoryChange}
      />
    );

    expect(screen.getByRole('tab', { name: /Notifications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Notification controls')).toBeVisible();

    view.rerender(
      <SettingsNavigation
        sections={sections}
        activeCategory="workflow"
        onActiveCategoryChange={onActiveCategoryChange}
      />
    );
    expect(screen.getByText('Merge controls')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /Notifications/ }));
    expect(onActiveCategoryChange).toHaveBeenCalledWith('notifications');
  });

  test('opens the old Automation tab links on Workflow & PR Rules', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=automation']}>
        <RoutedSettingsNavigation />
      </MemoryRouter>
    );
    expect(screen.getByRole('tab', { name: 'Workflow & PR Rules' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Merge controls')).toBeVisible();
  });

  test.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'falls back to General for the inherited object key ?tab=%s',
    (tab) => {
      render(
        <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
          <RoutedSettingsNavigation />
        </MemoryRouter>
      );
      expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Tip controls')).toBeVisible();
      expect(screen.getByRole('complementary', { name: 'About General' })).toBeInTheDocument();
    }
  );

  test('reacts to a notification route while another settings tab is open', () => {
    render(
      <MemoryRouter initialEntries={['/settings?flow=desktop&tab=automation']}>
        <RoutedSettingsNavigation />
      </MemoryRouter>
    );
    expect(screen.getByText('Merge controls')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open notification settings' }));
    expect(screen.getByRole('tab', { name: /Notifications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Notification controls')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    expect(screen.getByTestId('settings-location')).toHaveTextContent('?flow=desktop&tab=sandbox');

    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByTestId('settings-location')).toHaveTextContent('?flow=desktop');
    expect(screen.getByTestId('settings-location')).not.toHaveTextContent('tab=');
  });

  test('searches every category and restores the selected tab when cleared', () => {
    render(<SettingsNavigation sections={sections} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Workflow & PR Rules' }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'quiet hours' }
    });

    expect(screen.getByText('Notification controls')).toBeVisible();
    expect(screen.getByText('Merge controls')).not.toBeVisible();
    expect(screen.getByText(/1 section matching “quiet hours”/)).toBeVisible();
    // Results mix categories, so each group names where its match lives.
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));

    expect(screen.getByText('Merge controls')).toBeVisible();
    expect(screen.getByText('Notification controls')).not.toBeVisible();
  });

  test('shows an actionable empty state for unmatched keywords', () => {
    render(<SettingsNavigation sections={sections} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'does-not-exist' }
    });

    expect(screen.getByText('No settings found')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Tip controls')).toBeVisible();
  });

  test('matches every word case-insensitively', () => {
    expect(matchesSettingsSearch(sections[1], 'MERGE conflicts')).toBe(true);
    expect(matchesSettingsSearch(sections[1], 'merge notifications')).toBe(false);
  });

  test('keeps navigation enabled while disabling settings in read-only mode', () => {
    render(
      <SettingsNavigation
        sections={[{
          id: 'model-selection',
          category: 'general',
          searchText: 'model',
          content: <input aria-label="Model setting" />
        }]}
        isReadOnly
      />
    );

    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Workflow & PR Rules' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Model setting' })).toBeDisabled();
  });
});
