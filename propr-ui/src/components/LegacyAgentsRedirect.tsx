import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/** Automations used to live under `/agents`; old links and bookmarks land on the same page. */
export const LegacyAgentsRedirect: React.FC = () => {
  const location = useLocation();
  const target = `${location.pathname.replace(/^\/agents(?=\/|$)/, '/automations')}${location.search}${location.hash}`;
  return <Navigate to={target} replace />;
};
