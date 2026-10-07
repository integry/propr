import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyAgentsRedirect } from './LegacyAgentsRedirect';

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
};

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/agents/*" element={<LegacyAgentsRedirect />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);

describe('LegacyAgentsRedirect', () => {
  afterEach(cleanup);

  it.each([
    ['/agents', '/automations'],
    ['/agents/new', '/automations/new'],
    ['/agents/a1/runs/r1?x=1#top', '/automations/a1/runs/r1?x=1#top'],
  ])('sends %s to %s', (from, to) => {
    renderAt(from);
    expect(screen.getByTestId('location')).toHaveTextContent(to);
  });
});
