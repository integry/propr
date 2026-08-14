/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getSystemStatus } from '../api/proprApi';
import type { ConnectAccountStatus } from '../api/proprTypes';
import { useCurrentUser } from './AuthContext';

const ConnectAccountContext = createContext<ConnectAccountStatus | undefined>(undefined);
const STATUS_REFRESH_INTERVAL_MS = 30_000;

interface ConnectAccountScope {
  disabled: boolean;
  login?: string;
  flow: string;
  tunnel: string;
}

interface ScopedConnectAccount {
  scope: ConnectAccountScope;
  account?: ConnectAccountStatus;
}

const isSameScope = (left: ConnectAccountScope, right: ConnectAccountScope): boolean =>
  left.disabled === right.disabled
  && left.login === right.login
  && left.flow === right.flow
  && left.tunnel === right.tunnel;

export const ConnectAccountProvider: React.FC<{
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ disabled = false, children }) => {
  const user = useCurrentUser();
  const location = useLocation();
  const [scopedAccount, setScopedAccount] = useState<ScopedConnectAccount>();
  // A hosted origin can serve multiple stacks. Changing its validated tunnel
  // selector must invalidate the previous stack's status even when the same GitHub
  // login is authenticated on both stacks.
  const params = new URLSearchParams(location.search);
  const flow = params.get('flow') ?? '';
  const tunnel = params.get('tunnel') ?? '';
  const accountScope = useMemo<ConnectAccountScope>(() => ({
    disabled,
    login: user?.login,
    flow,
    tunnel,
  }), [disabled, flow, tunnel, user?.login]);
  const account = scopedAccount && isSameScope(scopedAccount.scope, accountScope)
    ? scopedAccount.account
    : undefined;

  useEffect(() => {
    let cancelled = false;
    let latestRequestId = 0;
    setScopedAccount(undefined);
    if (disabled || !user?.login) return () => { cancelled = true; };

    const refresh = async () => {
      const requestId = ++latestRequestId;
      try {
        const status = await getSystemStatus();
        if (!cancelled && requestId === latestRequestId) {
          setScopedAccount({ scope: accountScope, account: status.connectAccount });
        }
      } catch {
        // Account data is an optional promotion/limit signal. A failed status load
        // means unknown, never Community, and must not disturb the working UI.
        if (!cancelled && requestId === latestRequestId) setScopedAccount(undefined);
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
  }, [accountScope, disabled, user?.login]);

  return (
    <ConnectAccountContext.Provider value={account}>
      {children}
    </ConnectAccountContext.Provider>
  );
};

export const useConnectAccount = (): ConnectAccountStatus | undefined =>
  useContext(ConnectAccountContext);
