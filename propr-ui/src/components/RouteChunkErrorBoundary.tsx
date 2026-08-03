import React from 'react';

interface RouteChunkErrorBoundaryState {
  error: Error | null;
}

export default class RouteChunkErrorBoundary extends React.Component<
  React.PropsWithChildren,
  RouteChunkErrorBoundaryState
> {
  state: RouteChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteChunkErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Failed to load or render a route:', error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4" role="alert">
        <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="text-sm font-medium uppercase tracking-wide text-red-600">Page update required</div>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">This page could not be loaded</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            A newer version of ProPR may have been deployed while this session was open. Reload to fetch the latest page files.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
