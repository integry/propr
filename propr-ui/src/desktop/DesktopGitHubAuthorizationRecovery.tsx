import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, GITHUB_REAUTH_REASON_MESSAGES, knownGitHubReauthReason, type GitHubReauthReason, type DesktopAccessInvalidEventDetail, type DesktopAdapters, type DesktopProfile } from './types';

/** Recovery keeps the connected tree mounted so the original action can be retried. */
export function DesktopGitHubAuthorizationRecovery({ adapters, profile, transportScope }: {
  adapters: DesktopAdapters;
  profile: DesktopProfile;
  transportScope?: string;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [opening, setOpening] = useState(false);
  const [browserError, setBrowserError] = useState(false);
  const [reason, setReason] = useState<GitHubReauthReason | undefined>();

  useEffect(() => {
    const required = (event: Event) => {
      const detail = (event as CustomEvent<DesktopAccessInvalidEventDetail>).detail;
      if (!transportScope || detail?.profileId !== profile.id || detail.transportScope !== transportScope) return;
      // Creation dialogs make the renderer root inert and trap focus. Join the
      // active dialog so recovery is usable without closing the original form.
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
      setContainer(dialogs.filter(dialog => !dialog.closest('[inert], [hidden]')).at(-1) ?? document.body);
      setReason(knownGitHubReauthReason(detail.reason));
      setVisible(true);
    };
    window.addEventListener(DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, required);
    return () => window.removeEventListener(DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, required);
  }, [profile.id, transportScope]);

  const openGitHubSignIn = async () => {
    setOpening(true);
    setBrowserError(false);
    try {
      // Use the saved instance origin, never a URL or redirect from an error response.
      // This starts OAuth even if the browser already has an instance session.
      // A loopback alias is moved server-side to the configured callback origin
      // before OAuth state is created, so the saved origin stays authoritative here.
      await adapters.externalBrowser.open(new URL('/api/auth/github', profile.baseUrl).href);
    } catch {
      setBrowserError(true);
    } finally {
      setOpening(false);
    }
  };

  if (!visible || !container) return null;
  return createPortal(<section className="desktop-github-recovery" role="region" aria-live="polite" aria-labelledby="desktop-github-recovery-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setVisible(false); }
  }}>
    <h2 id="desktop-github-recovery-title">Authorize GitHub repository access</h2>
    {reason && <p className="desktop-github-recovery-reason">{GITHUB_REAUTH_REASON_MESSAGES[reason]}</p>}
    <p>Your Desktop pairing is still connected. Pairing again does not renew GitHub authorization.</p>
    <p>Sign in to this instance in your browser with {profile.account ? <strong>@{profile.account.username}</strong> : 'the same GitHub account as Desktop'}. If the browser uses another account, switch to this account first.</p>
    <p>After GitHub sign-in, return to Desktop and retry your original action. Your current work stays open.</p>
    <p>Reaching your browser dashboard does not by itself renew authorization. If the browser shows a sign-in error, or this notice returns after retrying, sign in again.</p>
    {browserError && <p role="alert">Could not open GitHub sign-in. Check your default browser, then try again.</p>}
    <div className="desktop-actions">
      <button type="button" className="desktop-primary-button" disabled={opening} onClick={() => void openGitHubSignIn()}>{opening ? 'Opening browser…' : 'Sign in with GitHub in browser'}</button>
      <button type="button" className="desktop-secondary-button" onClick={() => setVisible(false)}>Return to my action</button>
    </div>
  </section>, container);
}
