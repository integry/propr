import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteChunkErrorBoundary from './RouteChunkErrorBoundary';

const BrokenRoute = () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/route-old.js');
};

describe('RouteChunkErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers reload guidance when a lazy route fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reloadPage = vi.fn();

    render(
      <RouteChunkErrorBoundary reloadPage={reloadPage}>
        <BrokenRoute />
      </RouteChunkErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This page could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('uses neutral guidance and can recover from an ordinary render error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let shouldThrow = true;
    const RecoverableRoute = () => {
      if (shouldThrow) throw new Error('deterministic component defect');
      return <div>Recovered route</div>;
    };

    render(
      <RouteChunkErrorBoundary>
        <RecoverableRoute />
      </RouteChunkErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on this page');
    expect(screen.getByRole('alert')).not.toHaveTextContent('newer version');
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered route')).toBeInTheDocument();
  });
});
