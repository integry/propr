import { basename, isAbsolute, resolve } from 'node:path';
import { PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS } from '../scripts/packaged-acceptance-clock.mjs';

export const PACKAGED_ACCEPTANCE_USER_DATA_PREFIX = 'propr-desktop-acceptance-';
export const PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS = Object.freeze([
  'http://127.0.0.2:41731',
  'http://127.0.0.3:41732',
  'http://127.0.0.4:41733',
] as const);
const ACCEPTANCE_USER_DATA_LEAF = /^propr-desktop-acceptance-[A-Za-z0-9]+$/;

interface AcceptanceAuthorizationInput {
  argv: readonly string[];
  defaultUserDataDirectory: string;
  environmentTriggered: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}

interface PackagedAcceptancePairingTiming {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Acceptance-only main-process fakes are deliberately unreachable from an
 * ordinary application launch. They require a packaged Linux binary, two
 * independent triggers, and a fresh, explicitly scoped profile directory.
 */
export const authorizePackagedAcceptanceTest = ({
  argv,
  defaultUserDataDirectory,
  environmentTriggered,
  isPackaged,
  platform,
}: AcceptanceAuthorizationInput): string | null => {
  const argumentTriggered = argv.includes('--propr-acceptance-test');
  if (!argumentTriggered && !environmentTriggered) return null;
  if (!argumentTriggered || !environmentTriggered) {
    throw new Error('Packaged desktop acceptance requires both explicit authorization triggers');
  }
  if (!isPackaged || platform !== 'linux') {
    throw new Error('Packaged desktop acceptance is supported only by the packaged Linux application');
  }
  const values = argv
    .filter(argument => argument.startsWith('--user-data-dir='))
    .map(argument => argument.slice('--user-data-dir='.length));
  if (values.length !== 1 || !values[0] || !isAbsolute(values[0])) {
    throw new Error('Packaged desktop acceptance requires one absolute --user-data-dir');
  }
  const requested = resolve(values[0]);
  if (requested === resolve(defaultUserDataDirectory)
    || !ACCEPTANCE_USER_DATA_LEAF.test(basename(requested))) {
    throw new Error(`Packaged desktop acceptance userData must use ${PACKAGED_ACCEPTANCE_USER_DATA_PREFIX}`);
  }
  return requested;
};

/**
 * Keep the deterministic protocol clock behind the same authorization result
 * as the other packaged-acceptance-only behavior. A null result covers normal
 * production, packaged smoke, and ordinary development launches.
 */
export const packagedAcceptancePairingTiming = (
  authorizedUserDataDirectory: string | null,
): PackagedAcceptancePairingTiming | undefined => authorizedUserDataDirectory === null
  ? undefined
  : {
      now: () => PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS,
      sleep: async (_milliseconds, _signal) => undefined,
    };
