/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext } from 'react';
import type { CurrentUser, InstancePermission } from '../api/proprTypes';

const AuthContext = createContext<CurrentUser | null>(null);
const RefreshAuthContext = createContext<() => Promise<void>>(async () => undefined);

export const AuthProvider: React.FC<{
  user: CurrentUser | null;
  refreshUser?: () => Promise<void>;
  children: React.ReactNode;
}> = ({
  user,
  refreshUser = async () => undefined,
  children
}) => (
  <AuthContext.Provider value={user}>
    <RefreshAuthContext.Provider value={refreshUser}>
      {children}
    </RefreshAuthContext.Provider>
  </AuthContext.Provider>
);

export function useCurrentUser(): CurrentUser | null {
  return useContext(AuthContext);
}

export function useRefreshCurrentUser(): () => Promise<void> {
  return useContext(RefreshAuthContext);
}

export function userHasPermission(
  user: CurrentUser | null,
  permission: InstancePermission
): boolean {
  return user?.permissions.includes(permission) === true;
}
