import React, { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { Plus, X } from 'lucide-react';
import { DesktopContext } from './DesktopContext';
import { ProfileEditor, ProfileList } from './DesktopExperiencePanels';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';

interface DesktopConnectedExperienceProps {
  adapters: DesktopAdapters;
  profile: DesktopProfile;
  result: Extract<DesktopConnectionResult, { status: 'ready' }>;
  profiles: DesktopProfile[];
  managerOpen: boolean;
  managerRef: RefObject<HTMLElement | null>;
  editing: DesktopProfile | 'new' | null;
  operationError: string | null;
  deepLinkError: string | null;
  editorNotice: string | null;
  hasPendingConnectCandidate: boolean;
  children: React.ReactNode;
  openManager(): void;
  closeManager(): void;
  closeEditor(): void;
  openEditor(profile: DesktopProfile | 'new'): void;
  connect(profile: DesktopProfile): Promise<void>;
  removeProfile(profile: DesktopProfile): Promise<void>;
  saveProfile(profile: DesktopProfile, shouldConnect?: boolean): Promise<void>;
  retry(): void;
  setManagerOpen(open: boolean): void;
}

export const DesktopConnectedExperience: React.FC<DesktopConnectedExperienceProps> = ({
  adapters, profile, result, profiles, managerOpen, managerRef, editing,
  operationError, deepLinkError, editorNotice, hasPendingConnectCandidate,
  children, openManager, closeManager, closeEditor, openEditor, connect,
  removeProfile, saveProfile, retry, setManagerOpen,
}) => {
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const online = () => setNetworkOffline(false);
    const offline = () => setNetworkOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  const displayedConnection: DesktopConnectionResult = networkOffline
    ? { status: 'offline', message: 'This computer is offline.' }
    : result;
  const contextValue = {
    isDesktop: true as const,
    platform: adapters.platform,
    profile,
    connection: displayedConnection,
    openProfileManager: openManager,
    authenticate: () => adapters.authentication.authenticate(profile),
    openConnectionHelp: () => adapters.externalBrowser.open('https://propr.dev'),
    retry,
    ...(adapters.acceptance ? {
      reportConnectedRendererReady: () => adapters.acceptance!.reportJourneyStage('REACT_CONNECTED'),
    } : {}),
  };

  return (
    <DesktopContext.Provider value={contextValue}>
      {deepLinkError && <div className="desktop-inline-error" role="alert">{deepLinkError}</div>}
      <div className={`desktop-app desktop-platform-${adapters.platform}`} inert={managerOpen} aria-hidden={managerOpen || undefined}>{children}</div>
      {managerOpen && (
        <div className="desktop-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeManager(); }}>
          <section ref={managerRef} className="desktop-profile-manager" role="dialog" aria-modal="true" aria-labelledby="desktop-manager-title" tabIndex={-1}>
            <header><div><span className="desktop-eyebrow">Desktop</span><h2 id="desktop-manager-title">Manage instances</h2></div><button type="button" className="desktop-icon-button" onClick={closeManager} aria-label="Close instance manager"><X /></button></header>
            {editing ? (
              <ProfileEditor key={editing === 'new' ? editing : editing.id} initial={editing === 'new' ? undefined : editing} candidate={hasPendingConnectCandidate} notice={editorNotice} operationError={operationError} onCancel={closeEditor} onSave={editedProfile => void saveProfile(editedProfile, hasPendingConnectCandidate || editing === 'new' || profile.id === editedProfile.id)} />
            ) : (
              <>
                {operationError && <div className="desktop-inline-error" role="alert">{operationError}</div>}
                <ProfileList profiles={profiles} onConnect={nextProfile => { setManagerOpen(false); void connect(nextProfile); }} onEdit={openEditor} onRemove={nextProfile => void removeProfile(nextProfile)} />
                <button type="button" className="desktop-secondary-button desktop-add-instance" onClick={() => openEditor('new')}><Plus /> Add instance</button>
              </>
            )}
          </section>
        </div>
      )}
    </DesktopContext.Provider>
  );
};
