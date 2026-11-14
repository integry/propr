import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPlugins } from '../../api/pluginsApi';
import { exampleAt, examplePlugin, member, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({ ...(await importOriginal<object>()), listPlugins: vi.fn() }));

const named = (id: string, name: string, category: 'messaging' | 'deployment', over = {}) => {
  const base = examplePlugin();
  return { ...base, ...over, id, manifest: { ...base.manifest!, id, name, category } };
};

describe('Plugins catalog', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a card per plugin with its name, description, category and state badge', async () => {
    vi.mocked(listPlugins).mockResolvedValue({ plugins: [examplePlugin(), named('chat', 'Team chat', 'messaging', { ...exampleAt('enabled') })] });
    renderPluginsPage();
    const cards = await screen.findAllByTestId('plugin-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Example pack');
    expect(cards[0]).toHaveTextContent('A small development plugin.');
    expect(cards[0]).toHaveTextContent('Other');
    expect(within(cards[0]).getByTestId('plugin-state')).toHaveTextContent('Not installed');
    expect(within(cards[1]).getByTestId('plugin-state')).toHaveTextContent('Enabled');
    expect(within(cards[1]).getByRole('link')).toHaveAttribute('href', '/plugins/chat');
  });

  it('filters by category and searches by name', async () => {
    vi.mocked(listPlugins).mockResolvedValue({ plugins: [examplePlugin(), named('chat', 'Team chat', 'messaging'), named('ship', 'Shipper', 'deployment')] });
    renderPluginsPage();
    await screen.findAllByTestId('plugin-card');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'messaging' } });
    expect(screen.getAllByTestId('plugin-card').map(card => card.textContent)).toEqual([expect.stringContaining('Team chat')]);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'SHIP' } });
    expect(screen.getAllByTestId('plugin-card').map(card => card.textContent)).toEqual([expect.stringContaining('Shipper')]);
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'nothing' } });
    expect(screen.queryAllByTestId('plugin-card')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No plugin matches this search.');
  });

  it('shows the API refusal when the list cannot be read', async () => {
    vi.mocked(listPlugins).mockRejectedValue(new Error('Current durable instance administrator access is required'));
    renderPluginsPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Current durable instance administrator access is required');
  });

  it('is not shown to members without instance settings administration', () => {
    renderPluginsPage('/plugins', member);
    expect(screen.getByRole('heading', { name: 'Administrator access required' })).toBeInTheDocument();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it('renders manifest text as plain text, never as markup', async () => {
    const base = examplePlugin();
    vi.mocked(listPlugins).mockResolvedValue({ plugins: [{ ...base, manifest: { ...base.manifest!, name: '<img src=x onerror=alert(1)>' } }] });
    const { container } = renderPluginsPage();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
