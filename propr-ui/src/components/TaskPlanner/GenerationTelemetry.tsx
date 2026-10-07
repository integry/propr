import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { GenerationTrace } from '../../api/proprApi';
import { formatTokenAmount } from './tokenFormat';
import { collectTelemetryFiles, getContextTokens, getDiscoveryFraction, type TelemetryPreview } from './generationTelemetryUtils';

const isStepDone = (trace: GenerationTrace | undefined, name: string) => trace?.steps?.find(step => step.name === name)?.status === 'completed';

const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [active]);
  return now;
};

/**
 * Live discovery telemetry shown under the generation steps: a running log of the files the run
 * has scanned with their match, and the context tokens accumulated so far, so a multi-minute scan
 * shows its work instead of an empty canvas.
 */
export const GenerationTelemetry: React.FC<{ trace?: GenerationTrace; preview?: TelemetryPreview; className?: string }> = ({ trace, preview, className = '' }) => {
  const files = useMemo(() => collectTelemetryFiles(trace, preview), [trace, preview]);
  const contextDone = isStepDone(trace, 'context');
  const llm = trace?.steps?.find(step => step.name === 'llm');
  const now = useNow(!contextDone);
  const fraction = getDiscoveryFraction(trace, now);
  const context = getContextTokens(trace, preview);
  const scannedCount = Math.min(files.length, Math.ceil(files.length * fraction));
  const scanned = files.slice(0, scannedCount);
  const accumulated = context ? Math.round(context.tokens * fraction) : null;
  const approx = context && !context.exact ? '≈' : '';
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [scannedCount, contextDone, llm?.status]);

  return (
    <section data-testid="generation-telemetry" aria-label="Discovery telemetry" className={`flex min-h-0 flex-col rounded-md border border-slate-200 bg-slate-50 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-slate-700">
          <Activity className="h-3.5 w-3.5 text-primary-600" aria-hidden="true" />
          Discovery
        </span>
        <span className="font-mono text-slate-600" data-testid="telemetry-files">
          {files.length > 0 ? `${scannedCount}/${files.length} files scanned` : 'Ranking candidate files…'}
        </span>
        {accumulated !== null && (
          <span className="font-mono text-slate-600 sm:ml-auto" data-testid="telemetry-tokens" aria-live="polite">
            {contextDone ? 'Context assembled' : 'Accumulating context'}: <span className="font-semibold text-slate-900">{approx}{formatTokenAmount(accumulated)} tokens</span>
          </span>
        )}
      </div>
      <ol ref={logRef} className="max-h-56 min-h-0 flex-1 overflow-y-auto md:max-h-none px-3 py-2 font-mono text-[11px] leading-5 text-slate-600" data-testid="telemetry-log">
        {scanned.length === 0 && <li className="italic text-slate-400">Waiting for the first ranked files…</li>}
        {scanned.map(file => (
          <li key={file.path} className="flex min-w-0 gap-2">
            <span className="flex-shrink-0 text-slate-400">Scanned</span>
            <span className="min-w-0 truncate text-slate-800" title={file.path}>{file.path}</span>
            {file.match !== undefined && <span className="flex-shrink-0 text-slate-500">({file.match}% match)</span>}
          </li>
        ))}
        {contextDone && context && (
          <li className="text-slate-800">Context assembled: {formatTokenAmount(context.tokens)} tokens from {files.length} files</li>
        )}
        {llm?.status === 'in_progress' && context && (
          <li className="text-primary-700">Prompting the model with {formatTokenAmount(context.tokens)} tokens…</li>
        )}
      </ol>
    </section>
  );
};

export default GenerationTelemetry;
