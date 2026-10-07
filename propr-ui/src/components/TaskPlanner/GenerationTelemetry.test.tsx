import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GenerationTrace } from '../../api/proprApi';
import { GenerationTelemetry } from './GenerationTelemetry';

const preview = {
  stats: { totalTokens: 840_000, costEstimate: 0, contextLength: 0, fileCount: 1 },
  smartSelection: [{ path: 'src/a.ts', reason: '', source: 'auto' as const, score: 80 }],
};
// Far enough into the estimate that the time-paced log shows the file.
const startedAt = new Date(Date.now() - 60_000).toISOString();

describe('GenerationTelemetry', () => {
  it('labels preview-derived discovery as an estimate', () => {
    const trace: GenerationTrace = { steps: [{ name: 'relevance', status: 'in_progress', data: { startedAt, estimatedDuration: 10_000 } }] };
    render(<GenerationTelemetry trace={trace} preview={preview} />);
    expect(screen.getByTestId('telemetry-estimate-note')).toHaveTextContent('Estimated from the last context preview');
    expect(screen.getByTestId('telemetry-log')).toHaveTextContent('Expected');
    expect(screen.getByTestId('telemetry-log')).not.toHaveTextContent('Scanned');
  });

  it('lists the run\'s own candidates as scanned once relevance reports them', () => {
    const trace: GenerationTrace = { steps: [
      { name: 'relevance', status: 'completed', data: { candidates: [{ path: 'src/a.ts', score: 10 }] } },
      { name: 'context', status: 'in_progress', data: { startedAt, estimatedDuration: 10_000 } },
    ] };
    render(<GenerationTelemetry trace={trace} preview={preview} />);
    expect(screen.getByTestId('telemetry-estimate-note')).toHaveTextContent('Progress estimated from elapsed time');
    expect(screen.getByTestId('telemetry-log')).toHaveTextContent('Scanned');
  });

  it('drops the estimate caption once the context is assembled', () => {
    const trace: GenerationTrace = { steps: [{ name: 'context', status: 'completed', data: { tokenCount: 900_000 } }] };
    render(<GenerationTelemetry trace={trace} preview={preview} />);
    expect(screen.queryByTestId('telemetry-estimate-note')).not.toBeInTheDocument();
  });
});
