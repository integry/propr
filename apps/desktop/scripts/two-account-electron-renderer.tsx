import React, { useContext, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { apiFetch, getDesktopConnectionScope, setDesktopConnectionScope } from '../../../propr-ui/src/api/apiClient';
import { logout } from '../../../propr-ui/src/api/proprApi';
import { SocketProvider } from '../../../propr-ui/src/contexts/SocketProvider';
import { SocketContext } from '../../../propr-ui/src/contexts/SocketContext';

const events: unknown[] = [];
const errors: string[] = [];
window.alert = message => errors.push(String(message));
let logoutEvents = 0;
window.addEventListener('propr:desktop-logged-out', () => { logoutEvents++; });
function Observe() {
  const context = useContext(SocketContext)!;
  useEffect(() => context.onTaskUpdate(value => events.push(value)), [context]);
  return null;
}
createRoot(document.getElementById('root')!).render(<SocketProvider><Observe /></SocketProvider>);
const bridge = window.proprDesktop!;
let pending: Promise<unknown>[] = [];
Object.assign(window, { accountSmoke: {
  events, errors,
  pair: async (profile: Parameters<typeof bridge.authentication.pair>[0]) => {
    const admission = await bridge.authentication.admit(profile.id);
    return bridge.authentication.pair(profile, admission.operationId);
  },
  activate: async (profile: Parameters<typeof bridge.connection.probe>[0]) => {
    setDesktopConnectionScope(null);
    await bridge.profiles.setActive(null);
    const probe = await bridge.connection.probe(profile);
    if (probe.status !== 'ready') throw new Error(`Probe failed: ${probe.status}`);
    const scope = await bridge.connection.activate(probe.activationTicket);
    setDesktopConnectionScope({ bridge, ...scope }, profile.apiBaseUrl);
    return scope;
  },
  async delay() {
    const outcome = (promise: Promise<unknown>) => promise.then(() => 'accepted', () => 'rejected');
    pending = [outcome(apiFetch('/api/late-rest'))];
    const response = await apiFetch('/api/late-body');
    const clone = response.clone();
    pending.push(outcome(response.json()), outcome(clone.json()));
  },
  settle: () => Promise.all(pending),
  current: async () => (await apiFetch('/api/current')).json(),
  logout,
  state: () => ({ active: getDesktopConnectionScope()?.profileId ?? null, logoutEvents, errors }),
} });
