/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext } from 'react';
import type { ConnectAccountStatus } from '../api/proprTypes';
import { useSharedSystemStatus } from './SystemStatusContext';

const ConnectAccountContext = createContext<ConnectAccountStatus | undefined>(undefined);

export const ConnectAccountProvider: React.FC<{
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ disabled = false, children }) => {
  const { status } = useSharedSystemStatus();
  // Status refresh ownership lives with the global header. Keeping the full
  // response in its authenticated provider lets account banners project the
  // same result without issuing a second startup request.
  const account = disabled ? undefined : status?.connectAccount;

  return (
    <ConnectAccountContext.Provider value={account}>
      {children}
    </ConnectAccountContext.Provider>
  );
};

export const useConnectAccount = (): ConnectAccountStatus | undefined =>
  useContext(ConnectAccountContext);
