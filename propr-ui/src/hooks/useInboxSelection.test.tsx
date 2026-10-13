import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { useInboxSelection } from './useInboxSelection';

// The write boundary refuses every write, as it does once history has moved on before the URL write.
vi.mock('../components/TaskList/hooks', () => ({
  useTaskSearchParams: () => [useSearchParams()[0], () => undefined],
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter initialEntries={['/inbox?notification=a']}>{children}</MemoryRouter>
);

describe('useInboxSelection', () => {
  test('a choice whose URL write was refused gives way to the next location', () => {
    const { result } = renderHook(() => ({ selection: useInboxSelection(), navigate: useNavigate() }), { wrapper });
    expect(result.current.selection.selectedId).toBe('a');

    act(() => result.current.selection.select('b'));
    // Held until the URL catches up, so fast j/k steps from the latest choice.
    expect(result.current.selection.selectedId).toBe('b');

    // The write never landed; the location that did (Back, a link) wins.
    act(() => result.current.navigate('/inbox?notification=c'));
    expect(result.current.selection.selectedId).toBe('c');
  });
});
