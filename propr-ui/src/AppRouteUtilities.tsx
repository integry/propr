import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { pathWithActiveHostedTunnelFlow } from './config/runtimeConfig';

export const HostedFlowRouteSync = ({ hostname }: { hostname?: string }) => {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    const nextPath = pathWithActiveHostedTunnelFlow(currentPath, hostname);
    if (nextPath !== currentPath) navigate(nextPath, { replace: true, state: location.state });
  }, [hostname, location, navigate]);

  return null;
};

export const NotFoundRouteContent = ({ hostname }: { hostname?: string }) => (
  <div className="py-20 text-center">
    <h2 className="mb-2 text-xl font-semibold text-gray-700">Page not found</h2>
    <p className="mb-4 text-gray-500">This page does not exist or has moved.</p>
    <Link to={pathWithActiveHostedTunnelFlow('/', hostname)} className="text-primary-600 underline hover:text-primary-700">
      Back to dashboard
    </Link>
  </div>
);
