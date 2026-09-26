import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, X } from 'lucide-react';
import type { ConnectAccountStatus } from '../api/proprTypes';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import { useConnectAccount } from '../contexts/ConnectAccountContext';
import {
  capacityFingerprint,
  connectPlusDismissalKey,
  connectUpgradeUrl,
  type CapacityFingerprintInput,
} from './connectPlusBannerState';

interface DismissalRecord {
  soft: boolean;
  capacity: string[];
}

const emptyDismissal = (): DismissalRecord => ({ soft: false, capacity: [] });
const CAPACITY_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const readDismissal = (key: string): DismissalRecord => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDismissal();
    const record = parsed as Record<string, unknown>;
    return {
      soft: record.soft === true,
      capacity: Array.isArray(record.capacity)
        ? record.capacity.filter((value): value is string => (
          typeof value === 'string' && CAPACITY_FINGERPRINT_PATTERN.test(value)
        )).slice(-1)
        : [],
    };
  } catch {
    return emptyDismissal();
  }
};

const storeDismissal = (key: string, record: DismissalRecord): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Storage may be disabled, full, or blocked. Closing still works for this
    // mounted session through component state below.
  }
};

function useSoftDismissal(account: ConnectAccountStatus) {
  const user = useCurrentUser();
  const key = useMemo(
    () => connectPlusDismissalKey(account.installationId, user?.login ?? ''),
    [account.installationId, user?.login],
  );
  const storedDismissed = useMemo(() => readDismissal(key).soft, [key]);
  const [sessionDismissals, setSessionDismissals] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const dismiss = useCallback(() => {
    const record = readDismissal(key);
    record.soft = true;
    storeDismissal(key, record);
    setSessionDismissals(current => current.has(key)
      ? current
      : new Set([...current, key]));
  }, [key]);

  return { dismissed: storedDismissed || sessionDismissals.has(key), dismiss };
}

interface CapacityFingerprintRequest {
  key: string;
  account: CapacityFingerprintInput;
}

interface CapacityDismissalState {
  request: CapacityFingerprintRequest | null;
  fingerprint: string | null;
  ready: boolean;
  dismissed: boolean;
}

function useCapacityDismissal(account: ConnectAccountStatus, capacityState: boolean) {
  const user = useCurrentUser();
  const key = useMemo(
    () => connectPlusDismissalKey(account.installationId, user?.login ?? ''),
    [account.installationId, user?.login],
  );
  const request = useMemo<CapacityFingerprintRequest>(() => ({
    key,
    account: {
      activeSeats: account.activeSeats,
      allowedSeats: account.allowedSeats,
      seatsRemaining: account.seatsRemaining,
      billingCycleResetAt: account.billingCycleResetAt,
      seatLimitBlockedAt: account.seatLimitBlockedAt,
    },
  }), [
    account.activeSeats,
    account.allowedSeats,
    account.billingCycleResetAt,
    account.seatLimitBlockedAt,
    account.seatsRemaining,
    key,
  ]);
  const [state, setState] = useState<CapacityDismissalState>({
    request: null,
    fingerprint: null,
    ready: false,
    dismissed: false,
  });

  useEffect(() => {
    let cancelled = false;

    if (!capacityState) {
      const record = readDismissal(request.key);
      if (record.capacity.length > 0) {
        record.capacity = [];
        storeDismissal(request.key, record);
      }
      setState({ request, fingerprint: null, ready: true, dismissed: false });
      return () => { cancelled = true; };
    }

    const resolveDismissal = async () => {
      try {
        const fingerprint = await capacityFingerprint(request.account);
        if (cancelled) return;
        const record = readDismissal(request.key);
        const dismissed = record.capacity[0] === fingerprint;
        if (record.capacity.length > 0 && !dismissed) {
          record.capacity = [];
          storeDismissal(request.key, record);
        }
        setState({
          request,
          fingerprint,
          ready: true,
          dismissed,
        });
      } catch {
        if (cancelled) return;
        // Fingerprinting includes a Web Crypto-independent path. Preserve a
        // session-only close if an unexpected browser failure still escapes it.
        setState({ request, fingerprint: null, ready: true, dismissed: false });
      }
    };

    void resolveDismissal();
    return () => { cancelled = true; };
  }, [capacityState, request]);

  const isCurrentRequest = state.request === request;
  const dismiss = useCallback(() => {
    if (!isCurrentRequest || !state.ready) return;
    if (state.fingerprint) {
      const record = readDismissal(request.key);
      record.capacity = [state.fingerprint];
      storeDismissal(request.key, record);
    }
    setState(current => current.request === request
      ? { ...current, dismissed: true }
      : current);
  }, [isCurrentRequest, request, state.fingerprint, state.ready]);

  return {
    ready: isCurrentRequest && state.ready,
    dismissed: isCurrentRequest && state.dismissed,
    dismiss,
  };
}

const isCapacityState = (account: ConnectAccountStatus): boolean =>
  account.activeSeats >= account.allowedSeats
  || account.seatsRemaining === 0
  || Boolean(account.seatLimitBlockedAt);

const CloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Dismiss ProPR Connect notice"
    className="absolute right-1 top-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-500 hover:bg-black/5 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
  >
    <X className="h-4 w-4" aria-hidden="true" />
  </button>
);

export const ConnectCapacityBanner: React.FC = () => {
  const account = useConnectAccount();
  if (!account || account.plan !== 'community' || account.hasPlusAccess) return null;
  return <CapacityBannerContent account={account} />;
};

const CapacityBannerContent: React.FC<{ account: ConnectAccountStatus }> = ({ account }) => {
  const user = useCurrentUser();
  const canManageMembers = userHasPermission(user, 'instance.manage_members');
  const capacityState = isCapacityState(account);
  const { ready, dismissed, dismiss } = useCapacityDismissal(account, capacityState);
  if (!capacityState || !ready || dismissed) return null;

  const isFull = account.activeSeats >= account.allowedSeats || account.seatsRemaining === 0;
  const title = isFull
    ? `Community seats are full — ${account.activeSeats} of ${account.allowedSeats} active`
    : `A developer was blocked by the Community seat limit — ${account.activeSeats} of ${account.allowedSeats} active`;

  return (
    <section
      role="status"
      aria-live="polite"
      className="relative w-full border-b border-amber-300 bg-amber-50 px-4 py-3 pr-12 sm:px-6 sm:pr-16"
    >
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-sm font-semibold text-amber-950">{title}</h2>
          <p className="mt-0.5 break-words text-sm text-amber-900">
            {isFull
              ? 'Additional developers are blocked before receiving a seat until the cycle resets.'
              : 'A developer was recently blocked before receiving a seat; the reported capacity has since changed.'}
          </p>
        </div>
        {canManageMembers ? (
          <a
            href={connectUpgradeUrl(account.installationId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit shrink-0 items-center justify-center rounded-md border border-transparent bg-primary-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-primary-700 focus:ring-offset-2 focus:ring-offset-amber-50"
          >
            Add seats with Plus
          </a>
        ) : (
          <p className="shrink-0 text-sm font-medium text-amber-950">Ask an instance administrator</p>
        )}
      </div>
      <CloseButton onClick={dismiss} />
    </section>
  );
};

export const ConnectSoftPromoBanner: React.FC = () => {
  const account = useConnectAccount();
  const user = useCurrentUser();
  if (!account
    || account.plan !== 'community'
    || account.hasPlusAccess
    || isCapacityState(account)
    || !userHasPermission(user, 'instance.manage_members')) return null;
  return <SoftBannerContent account={account} />;
};

const SoftBannerContent: React.FC<{ account: ConnectAccountStatus }> = ({ account }) => {
  const { dismissed, dismiss } = useSoftDismissal(account);
  if (dismissed) return null;

  return (
    <section
      aria-label="ProPR Connect Plus"
      className="relative mx-4 mt-4 min-w-0 rounded-lg border border-slate-300 bg-blue-50 px-3 py-2.5 pr-12 sm:mx-6 sm:px-4 sm:pr-14"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="mt-0.5 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 sm:flex">
          <Cloud className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-950">Open your local ProPR workspace from anywhere</h2>
            <span className="rounded-full bg-primary-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ring-1 ring-inset ring-primary-700">
              PLUS
            </span>
          </div>
          <p className="mt-0.5 break-words text-pretty text-sm text-slate-700">
            Check agent progress from your phone or laptop. Connect Plus securely routes your local UI to the web—no VPN or open ports required.
          </p>
        </div>
        <a
          href={connectUpgradeUrl(account.installationId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit shrink-0 items-center justify-center rounded-md border border-transparent bg-primary-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-primary-700 focus:ring-offset-2 focus:ring-offset-blue-50"
        >
          Explore Plus
        </a>
      </div>
      <CloseButton onClick={dismiss} />
    </section>
  );
};
