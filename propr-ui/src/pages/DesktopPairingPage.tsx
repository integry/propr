import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  approveDesktopPairing,
  getDesktopPairingApproval,
  type DesktopPairingApproval,
} from '../api/desktopAuth';

const PAIRING_ID_PATTERN = /^dpr_[A-Za-z0-9_-]{22}$/;

const DesktopPairingPage = () => {
  const [searchParams] = useSearchParams();
  const pairingId = useMemo(() => searchParams.get('pairing_id') ?? '', [searchParams]);
  const [pairing, setPairing] = useState<DesktopPairingApproval | null>(null);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    if (!PAIRING_ID_PATTERN.test(pairingId)) {
      setError('This desktop pairing link is invalid. Start pairing again from the desktop app.');
      return;
    }
    let cancelled = false;
    getDesktopPairingApproval(pairingId)
      .then(result => { if (!cancelled) setPairing(result); })
      .catch(() => {
        if (!cancelled) setError('This pairing request was not found or has expired. Start pairing again from the desktop app.');
      });
    return () => { cancelled = true; };
  }, [pairingId]);

  const approve = async () => {
    if (!pairing || pairing.status !== 'pending') return;
    setApproving(true);
    setError('');
    try {
      setPairing(await approveDesktopPairing(pairing.pairingId));
    } catch {
      setError('The pairing request could not be approved. It may have expired; start pairing again from the desktop app.');
    } finally {
      setApproving(false);
    }
  };

  const completed = pairing?.status === 'approved' || pairing?.status === 'consumed';

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <img src="/media/logo-and-name.png" alt="ProPR" className="mb-6 h-10 w-auto" />
        <h1 className="text-xl font-semibold text-gray-950">
          {completed ? 'Desktop paired' : 'Approve desktop access'}
        </h1>
        {pairing && !completed && (
          <>
            <p className="mt-3 text-sm leading-6 text-gray-600">
              Allow <strong className="font-semibold text-gray-900">{pairing.clientName}</strong> to access this ProPR instance as you.
              It receives your current instance role and permissions, but never your GitHub access token.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => void approve()}
                disabled={approving}
                className="inline-flex flex-1 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {approving ? 'Approving…' : 'Approve desktop'}
              </button>
              <button
                type="button"
                onClick={() => window.close()}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {completed && (
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Return to the ProPR desktop app. You can revoke this device later from any authenticated client.
          </p>
        )}
        {!pairing && !error && <p className="mt-3 text-sm text-gray-600">Loading pairing request…</p>}
        {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </section>
    </main>
  );
};

export default DesktopPairingPage;
