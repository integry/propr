import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteChunkErrorBoundary from './RouteChunkErrorBoundary';

const BrokenRoute = () => {
  throw new Error('stale route chunk');
};

describe('RouteChunkErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers reload guidance when a lazy route fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <RouteChunkErrorBoundary>
        <BrokenRoute />
      </RouteChunkErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This page could not be loaded');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });
});
