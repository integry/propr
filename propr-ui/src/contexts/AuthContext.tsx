/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext } from 'react';
import type { CurrentUser, InstancePermission } from '../api/proprTypes';

const AuthContext = createContext<CurrentUser | null>(null);

export const AuthProvider: React.FC<{ user: CurrentUser | null; children: React.ReactNode }> = ({
  user,
  children
}) => <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;

export function useCurrentUser(): CurrentUser | null {
  return useContext(AuthContext);
}

export function userHasPermission(
  user: CurrentUser | null,
  permission: InstancePermission
): boolean {
  return user?.permissions.includes(permission) === true;
}
