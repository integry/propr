import { describe, expect, it } from 'vitest';
import { goalsReturnTarget } from './goalsUrlState';

describe('goalsReturnTarget', () => {
  it('accepts only canonical same-origin Goals list state', () => {
    expect(goalsReturnTarget('/goals?state=paused&repository=integry%2Fpropr&search=work&cursor=cursor2&cursorHistory=%5Bnull%5D'))
      .toBe('/goals?state=paused&repository=integry%2Fpropr&search=work&cursor=cursor2&cursorHistory=%5Bnull%5D');
  });

  it.each([
    'https://evil.example/goals', '//evil.example/goals', '/tasks', '/goals#external',
    '/goals?cursor=bad%2Bcursor&cursorHistory=%5Bnull%5D',
  ])('rejects an external, off-route, fragment, or malformed return target: %s', target => {
    expect(goalsReturnTarget(target)).toBe('/goals');
  });
});
