import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LlmLogEntry, LlmLogsPagination } from '../api/llmLogsApi';
import { LlmLogTable } from './LlmLogsTable';
import { PaginationFooter } from './LlmLogsPageComponents';
import { EXECUTION_TYPE_LABELS, formatTimestamp, formatTokens, formatType } from './llmLogsUtils';
import { formatModelName } from '../utils/modelDisplay';

function log(overrides: Partial<LlmLogEntry> = {}): LlmLogEntry {
  return {
    logId: 1,
    executionType: 'plan_generation_with_refinement',
    modelName: 'claude-opus-4-1-20250805',
    startTime: '2026-09-24T10:00:00.000Z',
    endTime: '2026-09-24T10:01:30.000Z',
    durationMs: 90_000,
    success: true,
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0.0123,
    errorMessage: null,
    sessionId: null,
    correlationId: null,
    draftId: null,
    repository: 'integry/propr',
    agentAlias: null,
    metadata: null,
    usageMetrics: null,
    usageMetricRecords: [],
    workType: 'task',
    taskId: 'task-1',
    taskNumber: 3607,
    prNumber: 3650,
    planDraftId: null,
    planIssueId: null,
    workRepository: 'integry/propr-with-a-very-long-repository-name-that-cannot-fit',
    ...overrides,
  };
}

const renderTable = (logs: LlmLogEntry[], expanded = new Set<number>(), onToggle = vi.fn()) => render(
  <MemoryRouter>
    <LlmLogTable logs={logs} expandedRows={expanded} onToggle={onToggle} />
  </MemoryRouter>,
);

describe('LlmLogTable', () => {
  it('fits the pane: a fixed-layout table with a set width on every column but the work reference', () => {
    renderTable([log()]);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('lg:table-fixed', 'w-full');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(8);
    const flexible = headers.filter(header => !/(^|\s)w-/.test(header.className));
    expect(flexible.map(header => header.textContent)).toEqual(['Work Ref']);
  });

  it('truncates a long work reference with its full text in the tooltip', () => {
    renderTable([log()]);
    const reference = 'integry/propr-with-a-very-long-repository-name-that-cannot-fit · Issue #3607, PR #3650';
    const cell = screen.getByTitle(reference);
    expect(cell).toHaveClass('truncate');
  });

  it('stacks each call below lg, with the hidden columns relocated into the row', () => {
    renderTable([log()]);
    const row = screen.getByTestId('llm-log-row');
    expect(row).toHaveClass('flex', 'lg:table-row');
    // Type, model, usage and duration are table columns from lg and a second line below it.
    expect(within(row).getAllByText('1m 30s')).toHaveLength(2);
    expect(within(row).getAllByTitle('Plan generation with refinement')).toHaveLength(2);
  });

  it('shows the human-readable model name, never the raw ID, in every model tooltip', () => {
    renderTable([log()]);
    const row = screen.getByTestId('llm-log-row');
    const label = formatModelName('claude-opus-4-1-20250805');
    expect(label).not.toBe('claude-opus-4-1-20250805');
    // The desktop column, the stacked line below lg and the narrow-desktop line under the work reference.
    const models = within(row).getAllByText(label).filter(node => node.classList.contains('font-mono'));
    expect(models).toHaveLength(3);
    for (const model of models) expect(model).toHaveAttribute('title', label);
    expect(row.querySelector('[title="claude-opus-4-1-20250805"]')).toBeNull();
  });

  it('shows a missing model as a dash with no tooltip', () => {
    renderTable([log({ modelName: null })]);
    const row = screen.getByTestId('llm-log-row');
    const dashes = within(row).getAllByText('-').filter(node => node.matches('span.font-mono.truncate'));
    expect(dashes).toHaveLength(3);
    for (const dash of dashes) expect(dash).not.toHaveAttribute('title');
  });

  it('shows the start as the shared relative age with the full local date and time in the tooltip', () => {
    renderTable([log()]);
    const time = screen.getByRole('table').querySelector('time');
    expect(time).toHaveAttribute('dateTime', '2026-09-24T10:00:00.000Z');
    expect(time).toHaveTextContent(formatTimestamp('2026-09-24T10:00:00.000Z'));
    expect(time?.getAttribute('title')).toMatch(/2026/);
  });

  it('renders a missing start as a dash', () => {
    renderTable([log({ startTime: null })]);
    expect(screen.getByRole('table').querySelector('time')).toBeNull();
    expect(formatTimestamp(null)).toBe('-');
  });

  it('sizes the type chip to fit whole from xl and the model in full from 1440px', () => {
    renderTable([log({ executionType: 'pr-review-context-scout', modelName: 'antigravity-gemini-3.8-flash' })]);
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader');
    const header = (label: string) => headers.find(node => node.textContent === label)!;
    expect(header('Type')).toHaveClass('w-32', 'xl:w-48');
    expect(header('Model')).toHaveClass('w-44', 'min-[1440px]:w-72');
    const row = screen.getByTestId('llm-log-row');
    expect(within(row).getAllByText('PR review context scout')).toHaveLength(2);
    // Only the model column wraps from 1440px; the stacked and narrow-desktop lines keep truncating.
    const models = within(row).getAllByText(formatModelName('antigravity-gemini-3.8-flash')).filter(node => node.classList.contains('font-mono'));
    const wrapping = models.filter(node => node.classList.contains('min-[1440px]:whitespace-normal'));
    expect(wrapping).toHaveLength(1);
    expect(wrapping[0].closest('td')).toHaveClass('xl:table-cell');
    for (const model of models) expect(model).toHaveClass('truncate');
  });

  it('opens the details of a row when it is clicked', () => {
    const onToggle = vi.fn();
    renderTable([log()], new Set(), onToggle);
    fireEvent.click(screen.getByTestId('llm-log-row'));
    expect(onToggle).toHaveBeenCalledWith(1);
  });
});

describe('formatType', () => {
  it('labels every execution type in sentence case with PR in capitals', () => {
    expect(formatType('pr-review')).toBe('PR review');
    expect(formatType('pr-review-context-scout')).toBe('PR review context scout');
    expect(formatType('title-generation')).toBe('Title generation');
    expect(formatType('summary-selection')).toBe('Summary selection');
    expect(formatType('repo-chat')).toBe('Repository chat');
    expect(formatType('other')).toBe('Other');
  });

  it('reads the same label for underscore and kebab spellings', () => {
    expect(formatType('pr_review_context_scout')).toBe('PR review context scout');
    expect(formatType('SUMMARY_SELECTION')).toBe('Summary selection');
  });

  it('covers every server execution type with a sentence-case label', () => {
    const serverTypes = [
      'implementation', 'plan-generation', 'plan-refinement', 'title-generation', 'summarization',
      'summary-selection', 'context-analysis', 'repo-chat', 'repo-improvements', 'pr-review',
      'pr-review-context-scout', 'usage-tips-selection', 'agent-health-check', 'other',
    ];
    for (const type of serverTypes) {
      const label = EXECUTION_TYPE_LABELS[type];
      expect(label, type).toBeDefined();
      // Only the first word and acronyms are capitalised.
      expect(label.split(' ').slice(1).every(word => word === 'PR' || word === word.toLowerCase()), label).toBe(true);
    }
  });

  it('falls back to sentence case with acronyms for an unknown type', () => {
    expect(formatType('ci_fix_attempt')).toBe('CI fix attempt');
    expect(formatType('plan_generation_with_refinement')).toBe('Plan generation with refinement');
  });
});

describe('formatTimestamp', () => {
  it('is relative for a week, then a date', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    expect(formatTimestamp('2026-09-24T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatTimestamp('2026-09-22T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatTimestamp('2026-08-01T12:00:00.000Z', now)).toMatch(/2026/);
  });
});

describe('counts', () => {
  it('formats token totals with the locale thousands separator', () => {
    expect(formatTokens(165297, 2048)).toBe(`${(165297).toLocaleString()} / ${(2048).toLocaleString()}`);
  });

  it('states the page range and total with thousands separators', () => {
    const pagination: LlmLogsPagination = { page: 1, limit: 20, total: 165297, totalPages: 8265, hasNextPage: true, hasPreviousPage: false };
    render(<PaginationFooter currentPage={1} totalPages={8265} pageSize={20} pagination={pagination} loading={false} onPageChange={vi.fn()} />);
    expect(screen.getByTestId('log-pagination-summary')).toHaveTextContent(`Showing 1–20 of ${(165297).toLocaleString()} entries`);
    expect(screen.getByTestId('log-pagination-summary')).toHaveTextContent(/165\D297/);
    expect(screen.getByText(`1/${(8265).toLocaleString()}`)).toBeInTheDocument();
  });
});
