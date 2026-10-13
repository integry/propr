import { GitHubAccountIdentity } from '../components/GitHubAccountIdentity';
import { useCurrentUser } from '../contexts/AuthContext';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_BASE_URL } from '../api/apiClient';
import { pathWithActiveHostedTunnelFlow } from '../config/runtimeConfig';
import {
  approveDesktopPairing,
  DesktopPairingUnavailableError,
  getDesktopPairingApproval,
  type DesktopPairingApproval,
} from '../api/desktopAuth';

const EXPIRED_MESSAGE = 'This pairing request was not found or has expired. Start pairing again from the desktop app.';

const PAIRING_ID_PATTERN = /^dpr_[A-Za-z0-9_-]{22}$/;

const signOutBrowserSession = async () => {
  const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
    credentials: 'include',
    redirect: 'manual',
  });
  if (!response.ok && response.type !== 'opaqueredirect' && !(response.status >= 300 && response.status < 400)) {
    throw new Error('Logout failed');
  }
};

const PairingFeedback = ({ cancelled, completed, userPresent, pairingPresent, error, loginPath }: {
  cancelled: boolean;
  completed: boolean;
  userPresent: boolean;
  pairingPresent: boolean;
  error: string;
  loginPath: string;
}) => (
  <>
    {cancelled && <p className="mt-3 text-sm leading-6 text-gray-600">Desktop access has not been approved. You can close this tab and return to Desktop. This request will expire automatically.</p>}
    {completed && (
      <p className="mt-3 text-sm leading-6 text-gray-600">
        Return to the ProPR desktop app. You can revoke this device later from any authenticated client.
      </p>
    )}
    {!userPresent && !error && <a href={loginPath} className="mt-4 flex min-h-11 items-center justify-center rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white">Sign in to review this pairing request</a>}
    {userPresent && !pairingPresent && !error && <p className="mt-3 text-sm text-gray-600">Loading pairing request…</p>}
    {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
  </>
);

const DesktopPairingPage = () => {
  const user = useCurrentUser();
  const userId = user?.id;
  const [searchParams] = useSearchParams();
  const pairingId = useMemo(() => searchParams.get('pairing_id') ?? '', [searchParams]);
  const [pairing, setPairing] = useState<DesktopPairingApproval | null>(null);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const accountSwitchGeneration = useRef(0);
  const approvalGeneration = useRef(0);
  const returnPath = pathWithActiveHostedTunnelFlow(`/desktop/pairing?pairing_id=${encodeURIComponent(pairingId)}`);
  const loginPath = pathWithActiveHostedTunnelFlow(`/login?logged_out=true&redirect_to=${encodeURIComponent(returnPath)}`);

  useLayoutEffect(() => {
    // Revoke old continuations at commit, before passive effects load the new
    // request, and on unmount. A request/identity returning later is a new flow.
    const generation = accountSwitchGeneration;
    const approval = approvalGeneration;
    return () => { generation.current++; approval.current++; };
  }, [pairingId, userId]);

  useEffect(() => {
    setPairing(null);
    setApproving(false);
    setError('');
    setChangingAccount(false);
    setSigningOut(false);
    setCancelled(false);
    if (!PAIRING_ID_PATTERN.test(pairingId)) {
      setError('This desktop pairing link is invalid. Start pairing again from the desktop app.');
      return;
    }
    if (!userId) return;
    let cancelled = false;
    getDesktopPairingApproval(pairingId)
      .then(result => { if (!cancelled) setPairing(result); })
      .catch(() => {
        if (!cancelled) setError('This pairing request was not found or has expired. Start pairing again from the desktop app.');
      });
    return () => { cancelled = true; };
  }, [pairingId, userId]);

  const expirePairing = () => {
    setPairing(null);
    setChangingAccount(false);
    setError(EXPIRED_MESSAGE);
  };

  useEffect(() => {
    if (!pairing || pairing.status !== 'pending') return;
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    if (remaining <= 0) {
      setPairing(null);
      setChangingAccount(false);
      setError(EXPIRED_MESSAGE);
      return;
    }
    const timeout = window.setTimeout(() => {
      setPairing(null);
      setChangingAccount(false);
      setError(EXPIRED_MESSAGE);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [pairing]);

  const approve = async () => {
    if (!user || !pairing || pairing.pairingId !== pairingId || pairing.status !== 'pending' || changingAccount || approving || cancelled) return;
    if (Date.parse(pairing.expiresAt) <= Date.now()) { expirePairing(); return; }
    const generation = ++approvalGeneration.current;
    setApproving(true);
    setError('');
    try {
      const result = await approveDesktopPairing(pairing.pairingId);
      if (generation !== approvalGeneration.current) return;
      setPairing(result);
      setError('');
    } catch (error) {
      if (generation !== approvalGeneration.current) return;
      if (error instanceof DesktopPairingUnavailableError || Date.parse(pairing.expiresAt) <= Date.now()) {
        setPairing(null);
        setChangingAccount(false);
      }
      setError('The pairing request could not be approved. It may have expired; start pairing again from the desktop app.');
    } finally {
      if (generation === approvalGeneration.current) setApproving(false);
    }
  };

  const changeAccount = async () => {
    if (signingOut || approving || !pairing || pairing.pairingId !== pairingId || pairing.status !== 'pending' || cancelled || !PAIRING_ID_PATTERN.test(pairingId)) return;
    if (Date.parse(pairing.expiresAt) <= Date.now()) { expirePairing(); return; }
    const generation = ++accountSwitchGeneration.current;
    setSigningOut(true);
    setError('');
    try {
      // Keep the exact request and active hosted tunnel instead of following
      // logout's generic login redirect. A full reload clears the old identity.
      await signOutBrowserSession();
      if (generation !== accountSwitchGeneration.current) return;
      if (Date.parse(pairing.expiresAt) <= Date.now()) {
        expirePairing();
        setSigningOut(false);
        return;
      }
      window.location.href = loginPath;
    } catch {
      if (generation !== accountSwitchGeneration.current) return;
      setError('Could not sign out of ProPR. Check your connection and try again. Desktop access has not been approved.');
      setSigningOut(false);
    }
  };

  const completed = pairing?.status === 'approved' || pairing?.status === 'consumed';

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <section className="w-full min-w-0 max-w-md rounded-xl border border-gray-200 bg-white p-4 shadow-sm [overflow-wrap:anywhere] sm:p-6">
        <img src="/media/logo-and-name.png" alt="ProPR" className="mb-6 h-10 w-auto max-w-full object-contain" />
        <h1 className="text-xl font-semibold text-gray-950">
          {cancelled ? 'Pairing cancelled' : completed ? 'Desktop paired' : 'Approve desktop access'}
        </h1>
        {pairing && !completed && !cancelled && (
          <>
            <p className="mt-3 text-sm leading-6 text-gray-600">
              Allow <strong className="font-semibold text-gray-900">{pairing.clientName}</strong> to access this ProPR instance as you.
              It receives your current instance role and permissions, but never your GitHub access token.
            </p>
            {user && (
              <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
                <p className="mb-2 text-sm font-medium text-gray-700">GitHub account receiving desktop access</p>
                <div className="text-base font-semibold text-gray-950 [&>span]:max-w-full [&>span]:min-w-0 [&>span>span]:min-w-0">
                  <GitHubAccountIdentity account={{ id: String(user.id), username: user.username || user.login, avatarUrl: user.avatarUrl ?? null }} />
                </div>
              </div>
            )}
            <p className="mt-3 text-sm leading-6 text-gray-600">Check the GitHub identity before approving. Desktop will ask you to confirm the approved identity before saving it.</p>
            {changingAccount ? (
              <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3">
                <h2 className="font-semibold text-gray-950">Change GitHub account</h2>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-gray-700">
                  <li>Open <a href="https://github.com/logout" target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline">GitHub sign out</a> in another tab, then sign in to the GitHub account you want to use. Return to this tab.</li>
                  <li>Use the button below to sign out of ProPR and sign in again. If ProPR Connect shows the wrong account, sign out of Connect too, then continue with the intended GitHub account.</li>
                  <li>After sign-in, return to this exact pairing request and check the identity again before approving. This link expires; if it has expired, start a new request from Desktop.</li>
                </ol>
                <button type="button" onClick={() => void changeAccount()} disabled={signingOut} className="mt-3 min-h-11 w-full rounded-md bg-blue-600 px-3 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {signingOut ? 'Signing out…' : 'Sign out of ProPR and sign in again'}
                </button>
                <button type="button" onClick={() => { setChangingAccount(false); setError(''); }} disabled={signingOut} className="mt-2 min-h-11 w-full rounded-md border border-gray-300 px-3 py-3 text-sm font-medium text-gray-700 hover:bg-white disabled:opacity-60">Keep current account</button>
              </div>
            ) : pairing.status === 'pending' && (
              <button type="button" onClick={() => setChangingAccount(true)} disabled={approving} className="mt-3 min-h-11 w-full rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">Change GitHub account</button>
            )}
            {!changingAccount && pairing.status === 'pending' && (
              <div className="mt-5 flex flex-col gap-3 min-[375px]:flex-row">
                <button
                  type="button"
                  onClick={() => void approve()}
                  disabled={approving || !user}
                  className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {approving ? 'Approving…' : 'Approve desktop'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCancelled(true); setError(''); }}
                  disabled={approving}
                  className="min-h-11 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
        <PairingFeedback
          cancelled={cancelled}
          completed={completed}
          userPresent={!!user}
          pairingPresent={!!pairing}
          error={error}
          loginPath={loginPath}
        />
      </section>
    </main>
  );
};

export default DesktopPairingPage;
