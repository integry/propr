import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppRoutes from './AppRoutes';

vi.mock('./components/Layout', () => ({ default: ({ children }: { children: React.ReactNode }) => <main data-testid="layout">{children}</main> }));
vi.mock('./components/RouteChunkErrorBoundary', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./pages/GoalsPage', () => ({ default: () => <h1>Goals route</h1> }));
vi.mock('./pages/GoalCreatePage', () => ({ default: () => <h1>Create goal route</h1> }));
vi.mock('./pages/GoalDetailPage', () => ({ default: () => <h1>Goal detail route</h1> }));

describe('AppRoutes goals navigation', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['/goals', 'Goals route'],
    ['/goals/new', 'Create goal route'],
    ['/goals/goal-123', 'Goal detail route'],
  ])('renders %s inside the application layout', async (path, heading) => {
    render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId('layout')).toContainElement(screen.getByRole('heading', { name: heading }));
  });
});
