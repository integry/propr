import React from 'react';

interface RouteChunkErrorBoundaryState {
  error: Error | null;
}

interface RouteChunkErrorBoundaryProps extends React.PropsWithChildren {
  reloadPage?: () => void;
}

const CHUNK_LOAD_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /failed to load module script/i,
  /loading chunk .+ failed/i,
  /chunkloaderror/i,
];

function normalizeRouteError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  let description: string;
  try {
    description = JSON.stringify(thrown) ?? String(thrown);
  } catch {
    description = String(thrown);
  }
  return new Error(`A route threw a non-Error value: ${description}`);
}

export function isRouteChunkLoadError(thrown: unknown): boolean {
  const error = normalizeRouteError(thrown);
  if (error.name === 'ChunkLoadError') return true;
  return CHUNK_LOAD_ERROR_PATTERNS.some(pattern => pattern.test(`${error.name}: ${error.message}`));
}

export default class RouteChunkErrorBoundary extends React.Component<
  RouteChunkErrorBoundaryProps,
  RouteChunkErrorBoundaryState
> {
  state: RouteChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteChunkErrorBoundaryState {
    return { error: normalizeRouteError(error) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Failed to load or render a route:', error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const isChunkLoadError = isRouteChunkLoadError(this.state.error);

    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4" role="alert">
        <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="text-sm font-medium uppercase tracking-wide text-red-600">
            {isChunkLoadError ? 'Page update required' : 'Page error'}
          </div>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            {isChunkLoadError ? 'This page could not be loaded' : 'Something went wrong on this page'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            {isChunkLoadError
              ? 'A newer version of ProPR may have been deployed while this session was open. Reload to fetch the latest page files.'
              : 'The page encountered an unexpected error. Try rendering it again; if the problem continues, reload and report the issue.'}
          </p>
          <button
            type="button"
            onClick={isChunkLoadError
              ? () => (this.props.reloadPage ?? (() => window.location.reload()))()
              : () => this.setState({ error: null })}
            className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {isChunkLoadError ? 'Reload page' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }
}
