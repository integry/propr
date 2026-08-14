/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getSystemStatus } from '../api/proprApi';
import type { ConnectAccountStatus } from '../api/proprTypes';
import { useCurrentUser } from './AuthContext';

const ConnectAccountContext = createContext<ConnectAccountStatus | undefined>(undefined);
const STATUS_REFRESH_INTERVAL_MS = 30_000;

export const ConnectAccountProvider: React.FC<{
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ disabled = false, children }) => {
  const user = useCurrentUser();
  const location = useLocation();
  const [account, setAccount] = useState<ConnectAccountStatus>();
  // A hosted origin can serve multiple stacks. Changing its validated tunnel
  // selector must invalidate the previous stack's status even when the same GitHub
  // login is authenticated on both stacks.
  const tunnelScope = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return `${params.get('flow') ?? ''}:${params.get('tunnel') ?? ''}`;
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;
    let latestRequestId = 0;
    setAccount(undefined);
    if (disabled || !user?.login) return () => { cancelled = true; };

    const refresh = async () => {
      const requestId = ++latestRequestId;
      try {
        const status = await getSystemStatus();
        if (!cancelled && requestId === latestRequestId) setAccount(status.connectAccount);
      } catch {
        // Account data is an optional promotion/limit signal. A failed status load
        // means unknown, never Community, and must not disturb the working UI.
        if (!cancelled && requestId === latestRequestId) setAccount(undefined);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };

    void refresh();
    const interval = window.setInterval(refreshWhenVisible, STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [disabled, tunnelScope, user?.login]);

  return (
    <ConnectAccountContext.Provider value={account}>
      {children}
    </ConnectAccountContext.Provider>
  );
};

export const useConnectAccount = (): ConnectAccountStatus | undefined =>
  useContext(ConnectAccountContext);
