import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ListSkeleton, SkeletonBlock } from './Skeleton';

const blocksIn = (element: HTMLElement) => Array.from(element.querySelectorAll('[data-skeleton-block]'));

describe('SkeletonBlock', () => {
  it('is a hidden slate-100 rounded-sm placeholder', () => {
    const { container } = render(<SkeletonBlock className="h-4 w-8" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block).toHaveClass('bg-slate-100', 'rounded-sm', 'h-4', 'w-8');
    expect(block).not.toHaveClass('animate-pulse');
  });

  it('pulses on its own only when asked to, and stops for reduced motion', () => {
    const { container } = render(<SkeletonBlock pulse className="h-8 w-16" />);
    expect(container.firstElementChild).toHaveClass('animate-pulse', 'motion-reduce:animate-none');
  });
});

describe('ListSkeleton', () => {
  it('exposes exactly one busy status with a screen-reader label', () => {
    render(<ListSkeleton label="Loading goals…" data-testid="goals-skeleton" />);
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    const [status] = statuses;
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('data-testid', 'goals-skeleton');
    expect(within(status).getByText('Loading goals…')).toHaveClass('sr-only');
    expect(screen.getAllByText('Loading goals…')).toHaveLength(1);
  });

  it('pulses once on the container and stops under prefers-reduced-motion', () => {
    render(<ListSkeleton label="Loading…" rows={4} />);
    const status = screen.getByRole('status');
    expect(status).toHaveClass('animate-pulse', 'motion-reduce:animate-none');
    blocksIn(status).forEach(block => expect(block).not.toHaveClass('animate-pulse'));
  });

  it('draws one full-width row placeholder per row by default', () => {
    render(<ListSkeleton label="Loading…" rows={5} />);
    const blocks = blocksIn(screen.getByRole('status'));
    expect(blocks).toHaveLength(5);
    blocks.forEach(block => {
      expect(block).toHaveClass('h-10', 'bg-slate-100', 'rounded-sm');
      expect(block).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('draws rows below lg and columns from lg up inside the same status', () => {
    render(<ListSkeleton label="Loading plans…" layout="table" rows={3} columns={6} />);
    const status = screen.getByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByText('Loading plans…')).toHaveLength(1);

    const narrow = status.querySelector('.lg\\:hidden') as HTMLElement;
    const wide = status.querySelector('.lg\\:block') as HTMLElement;
    expect(blocksIn(narrow)).toHaveLength(3);
    expect(wide).toHaveClass('hidden');
    const rows = Array.from(wide.querySelectorAll('.grid'));
    expect(rows).toHaveLength(3);
    rows.forEach(row => expect(blocksIn(row as HTMLElement)).toHaveLength(6));
  });

  it('shapes a console as a title, a metadata line and its blocks', () => {
    render(<ListSkeleton label="Loading goal…" layout="card" rows={3} />);
    expect(blocksIn(screen.getByRole('status'))).toHaveLength(5);
  });

  it('draws tall blocks for the block layout', () => {
    render(<ListSkeleton label="Loading…" layout="block" rows={2} />);
    const blocks = blocksIn(screen.getByRole('status'));
    expect(blocks).toHaveLength(2);
    blocks.forEach(block => expect(block).toHaveClass('h-32'));
  });

  it('spends no rules on rows', () => {
    const { container } = render(<ListSkeleton label="Loading…" layout="table" rows={3} columns={4} />);
    expect(container.querySelector('[class*="border"]')).toBeNull();
    expect(container.querySelector('[class*="divide"]')).toBeNull();
  });
});
