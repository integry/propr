import type { AgentRuntimePackageState } from '../../api/agentRuntimeApi';

function conciseBuildError(value?: string): string | null {
  if (!value) return null;
  const clean = value.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
  const preferred = [
    /unable to locate package/i,
    /no such package/i,
    /not found/i,
    /unsupported package manager/i,
    /returned a non-zero code/i
  ];
  for (const pattern of preferred) {
    const line = [...lines].reverse().find(candidate => pattern.test(candidate));
    if (line) return line.slice(0, 240);
  }
  return (lines[lines.length - 1] || value).slice(0, 240);
}

/** The save warning, the request or build error, and the failed build's log. */
export function AgentRuntimePackageMessages({ warning, error, state, runtimeErrorsShown = false }: {
  warning: string | null;
  error: string | null;
  state: AgentRuntimePackageState;
  /** The per-runtime rows already show each runtime's build or check error. */
  runtimeErrorsShown?: boolean;
}) {
  const stateError = runtimeErrorsShown ? undefined : state.error;
  return (
    <>
      {warning && !error && (
        <p className="mt-2 break-words text-[12px] leading-5 text-amber-700" role="status">Warning: {warning}</p>
      )}
      {(error || stateError) && (
        <p className="mt-2 break-words text-[12px] leading-5 text-red-600">{error || conciseBuildError(stateError)}</p>
      )}
      {state.status === 'failed' && (state.buildLog || (state.error && state.error.length > 240)) && (
        <details className="mt-2 text-[12px] text-slate-500">
          <summary className="cursor-pointer select-none">Build details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-slate-200 pl-2 text-[10px] leading-4 text-slate-500">
            {state.buildLog || state.error}
          </pre>
        </details>
      )}
    </>
  );
}
