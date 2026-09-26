import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sentinels = [
  'https://user:password-sentinel@t-invalid.propr.dev',
  'https://t-invalid.propr.dev?token=query-token-sentinel',
  `https://example.test/${'private-path-sentinel'.repeat(200)}`,
  'this is not a URL malformed-url-sentinel',
];

describe('invalid eager API configuration', () => {
  afterEach(() => {
    cleanup();
    delete window.__PROPR_CONFIG__;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(sentinels)('renders a bounded safe connection screen without leaking configured input', async configured => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__PROPR_CONFIG__ = { apiBaseUrl: configured };

    const runtimeConfig = await import('./config/runtimeConfig');
    console.warn(runtimeConfig.runtimeConfigWarning('app.propr.dev', window.__PROPR_CONFIG__));
    const apiClient = await import('./api/apiClient');
    expect(apiClient.proprClient).toBeNull();
    let thrown: unknown;
    try { apiClient.getProprClient(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('The ProPR connection configuration is invalid.');

    const { default: App } = await import('./App');
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Invalid ProPR configuration' })).toBeInTheDocument();
    const visible = document.body.textContent || '';
    const diagnostics = JSON.stringify([
      ...warn.mock.calls,
      ...error.mock.calls,
      thrown,
    ]);
    for (const secret of ['password-sentinel', 'query-token-sentinel', 'private-path-sentinel', 'malformed-url-sentinel']) {
      expect(visible).not.toContain(secret);
      expect(diagnostics).not.toContain(secret);
    }
    expect(visible.length).toBeLessThan(1000);
  });
});
