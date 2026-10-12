import { ACCOUNT, ACCOUNT_ID, REPOSITORY, fail } from './live-github-smoke.mjs';

// No network, Electron, browser session, or provider credentials in fixture mode.
export function fixtureDriver({ failure, username = ACCOUNT, id = ACCOUNT_ID, calls = [] } = {}) {
  const step = (name, value) => async () => {
    calls.push(name);
    if (failure?.step === name) fail(failure.result);
    return value;
  };
  return {
    preflight: step('preflight'), startPairing: step('startPairing'),
    browserSignIn: step('browserSignIn'), browserAccount: step('browserAccount', { username, id }),
    approve: step('approve'), confirmedAccount: step('confirmedAccount', { username, id }),
    connect: step('connect'), connectedAccount: step('connectedAccount', { username, id }),
    repositoryUsable: async repository => {
      calls.push('repositoryUsable');
      if (failure?.step === 'repositoryUsable') fail(failure.result);
      return repository === REPOSITORY;
    },
  };
}
