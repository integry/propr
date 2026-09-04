import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isProprLoopbackHostname } from '@propr/shared';
import { connectApiBaseUrlFromDeepLink } from '../../../apps/desktop/src/security';
import { DesktopDeepLinkNavigation, type DesktopDeepLinkInbox } from '../desktop-deep-link';
import type { DesktopProfile } from './types';

const REJECTED_DEEP_LINK_MESSAGE = 'ProPR Desktop could not use that link. Choose an instance and try again.';
const CONNECT_CANDIDATE_NOTICE = 'Review this untrusted instance address, then choose Connect to continue.';

type DesktopDeepLinkPhase = 'loading' | 'choose' | 'connecting' | 'blocked' | 'recovery-review' | 'connected';

interface UseDesktopDeepLinksOptions {
  deepLinks?: DesktopDeepLinkInbox;
  phase: DesktopDeepLinkPhase;
  profileId: string | null;
  activeProfileId: RefObject<string | null>;
  onStageConnectCandidate(candidate: DesktopProfile, phase: DesktopDeepLinkPhase): void;
}

interface DesktopDeepLinkState {
  deepLinkError: string | null;
  editorNotice: string | null;
  clearConnectCandidate(): void;
  hasPendingConnectCandidate(): boolean;
}

const createProfileId = (): string => {
  try { return crypto.randomUUID(); } catch { return `profile-${Date.now()}`; }
};

/** Owns the one-consumer renderer handoff and stages Connect links without performing connection work. */
export const useDesktopDeepLinks = ({
  deepLinks,
  phase,
  profileId,
  activeProfileId,
  onStageConnectCandidate,
}: UseDesktopDeepLinksOptions): DesktopDeepLinkState => {
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const pendingConnectCandidate = useRef(false);
  const startupOpenLinks = useRef<string[]>([]);
  const phaseRef = useRef(phase);
  const profileIdRef = useRef(profileId);
  const stageCandidateRef = useRef(onStageConnectCandidate);
  phaseRef.current = phase;
  profileIdRef.current = profileId;
  stageCandidateRef.current = onStageConnectCandidate;

  const [navigation] = useState(() => new DesktopDeepLinkNavigation(
    path => {
      window.location.hash = path;
      setDeepLinkError(null);
    },
    () => setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE),
  ));
  const handler = useRef<(value: string) => void>(() => undefined);

  handler.current = value => {
    let action: string | null = null;
    try {
      const url = new URL(value);
      if (url.protocol === 'propr:') action = url.hostname;
    } catch {
      // The fixed rejection below deliberately omits attacker-controlled input.
    }

    if (action === 'connect') {
      const baseUrl = connectApiBaseUrlFromDeepLink(value);
      if (!baseUrl) {
        setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
        return;
      }
      const candidate: DesktopProfile = {
        id: createProfileId(),
        name: 'Discovered ProPR instance',
        baseUrl,
        kind: isProprLoopbackHostname(new URL(baseUrl).hostname) ? 'local' : 'remote',
      };
      pendingConnectCandidate.current = true;
      setDeepLinkError(null);
      setEditorNotice(CONNECT_CANDIDATE_NOTICE);
      stageCandidateRef.current(candidate, phaseRef.current);
      return;
    }

    if (action === 'open') {
      const currentPhase = phaseRef.current;
      const currentProfileId = profileIdRef.current;
      if (currentPhase === 'loading') {
        startupOpenLinks.current.push(value);
        return;
      }
      if ((currentPhase === 'connecting' || currentPhase === 'connected') && currentProfileId) {
        if (activeProfileId.current !== currentProfileId
          || !navigation.receive(value, currentProfileId)) {
          setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
        }
        return;
      }
    }

    setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
  };

  useEffect(() => deepLinks?.subscribe(value => handler.current(value)), [deepLinks]);

  useEffect(() => {
    if (phase === 'connecting' && profileId) {
      navigation.setDashboardUnavailable();
      if (activeProfileId.current === profileId) {
        startupOpenLinks.current.splice(0).forEach(value => navigation.receive(value, profileId));
      } else if (startupOpenLinks.current.splice(0).length > 0) {
        setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      }
      return;
    }
    if (phase === 'connected' && profileId) {
      if (activeProfileId.current === profileId) navigation.setDashboardReady(profileId);
      else setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      return;
    }
    navigation.setDashboardUnavailable();
    if (phase !== 'loading') {
      if (startupOpenLinks.current.splice(0).length > 0) setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      navigation.rejectPending();
    }
  }, [activeProfileId, navigation, phase, profileId]);

  const clearConnectCandidate = useCallback(() => {
    pendingConnectCandidate.current = false;
    setEditorNotice(null);
  }, []);
  const hasPendingConnectCandidate = useCallback(() => pendingConnectCandidate.current, []);

  return { deepLinkError, editorNotice, clearConnectCandidate, hasPendingConnectCandidate };
};
