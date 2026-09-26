import { parseProprConnectEndpoint } from '@propr/shared';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { recoverableError, settleAuthenticationCancellation, type ExperienceState } from './desktopExperienceState';
import {
  DesktopAuthenticationError,
  type DesktopAdapters,
  type DesktopAuthenticationProgressStage,
  type DesktopConnectionResult,
  type DesktopProfile,
} from './types';

interface DesktopAuthenticationActionOptions {
  adapters: DesktopAdapters;
  cancelDiscovery(): void;
  connect(profile: DesktopProfile): Promise<void>;
  connectionAttempt: MutableRefObject<number>;
  reportCredentialCommitted(): Promise<void>;
  setOperationError: Dispatch<SetStateAction<string | null>>;
  setState: Dispatch<SetStateAction<ExperienceState>>;
}

const authenticationFailureMessage = (
  error: unknown,
  progress: DesktopAuthenticationProgressStage,
): string => {
  if (error instanceof DesktopAuthenticationError) {
    if (error.code === 'APPROVAL_EXPIRED') {
      return progress === 'browser-open-failed'
        ? 'Browser approval expired. If no approval page appeared, check your default browser or desktop portal, then start sign in again.'
        : 'Browser approval expired before it was completed. Start sign in again.';
    }
    if (error.code === 'SECURE_STORAGE_FAILED') {
      return 'ProPR Desktop could not save the approved credential in secure storage. Unlock or enable your system keychain, then try again.';
    }
    if (error.code === 'PAIRING_UNREACHABLE') {
      return 'The instance became unreachable while waiting for browser approval. Check the connection and try again.';
    }
    if (error.code === 'ACCOUNT_MISMATCH') {
      return 'Your browser approved a different GitHub account. Open the approval link in a browser profile signed in to this saved account, or use Add account to save a different user.';
    }
    if (error.code === 'PAIRING_CANCELLED') {
      return 'Account confirmation was cancelled. Start sign in again when you are ready.';
    }
    if (error.code === 'PAIRING_REJECTED') {
      return 'ProPR Desktop could not verify the pairing response for this endpoint. Confirm the instance is up to date, then try again.';
    }
  }
  return 'Desktop pairing could not be completed. Try again.';
};

export const createDesktopAuthenticationActions = ({
  adapters,
  cancelDiscovery,
  connect,
  connectionAttempt,
  reportCredentialCommitted,
  setOperationError,
  setState,
}: DesktopAuthenticationActionOptions) => {
  const authenticate = async (
    profile: DesktopProfile,
    result: Extract<DesktopConnectionResult, { status: 'authentication-required' }>,
  ) => {
    cancelDiscovery();
    const attempt = ++connectionAttempt.current;
    let progress: DesktopAuthenticationProgressStage = 'starting';
    setOperationError(null);
    setState({ phase: 'authenticating', profile, result, progress });
    try {
      await adapters.authentication.authenticate(profile, nextProgress => {
        if (connectionAttempt.current !== attempt) return;
        progress = nextProgress;
        setState(current => current.phase === 'authenticating' && current.profile.id === profile.id
          ? { ...current, progress: nextProgress }
          : current);
      });
      if (connectionAttempt.current !== attempt) return;
      await reportCredentialCommitted();
      if (connectionAttempt.current === attempt) await connect(profile);
    } catch (error) {
      if (connectionAttempt.current !== attempt) return;
      setState({
        phase: 'blocked',
        profile,
        result: { ...result, message: authenticationFailureMessage(error, progress) },
      });
    }
  };

  const cancelAuthentication = (current: Extract<ExperienceState, { phase: 'authenticating' }>) => {
    connectionAttempt.current += 1;
    settleAuthenticationCancellation(adapters, current.profile.id);
    setState({ phase: 'blocked', profile: current.profile, result: current.result });
  };

  const runBlockedAction = async (
    profile: DesktopProfile,
    action: () => Promise<void>,
    failureMessage: string,
    connectFailureMessage?: string,
    onSuccess?: () => Promise<void>,
  ) => {
    cancelDiscovery();
    const attempt = connectionAttempt.current;
    try {
      await action();
      if (connectionAttempt.current === attempt) await onSuccess?.();
    } catch {
      const message = recoverableError(failureMessage);
      setState(current => current.phase === 'blocked' && current.profile.id === profile.id
        ? {
          ...current,
          result: parseProprConnectEndpoint(profile.baseUrl) && connectFailureMessage
            ? { status: 'offline', message: recoverableError(connectFailureMessage) }
            : { ...current.result, message },
        }
        : current);
    }
  };

  return { authenticate, cancelAuthentication, runBlockedAction };
};
