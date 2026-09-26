import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseDesktopPairingStart, ProprClientError } from '@propr/client';
import {
  PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS,
  PACKAGED_ACCEPTANCE_TIME,
} from '../scripts/packaged-acceptance-clock.mjs';
import {
  authorizePackagedAcceptanceTest,
  packagedAcceptancePairingTiming,
  packagedAcceptanceAccountConfirmation,
  PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS,
} from './acceptance-test-authorization';
import { sanitizeDesktopLogFields } from './logger';

const acceptanceUserData = resolve('/tmp/propr-desktop-acceptance-a1');
const defaultUserData = resolve('/tmp/default');
const input = {
  argv: ['app', '--propr-acceptance-test', `--user-data-dir=${acceptanceUserData}`],
  defaultUserDataDirectory: defaultUserData,
  environmentTriggered: true,
  isPackaged: true,
  platform: 'linux' as const,
};

describe('packaged acceptance authorization', () => {
  it('confirms only one exact synthetic account at a ready/revoked fixture in an authorized launch', async () => {
    assert.equal(packagedAcceptanceAccountConfirmation(null), undefined);
    const account = { id: '2296', username: 'acceptance-admin', avatarUrl: null };
    const signal = new AbortController().signal;
    const directory = authorizePackagedAcceptanceTest(input);
    for (const origin of PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS.slice(0, 2)) {
      const confirm = packagedAcceptanceAccountConfirmation(directory)!;
      for (const wrong of [
        { ...account, id: '123' }, { ...account, username: 'real-user' },
        { ...account, avatarUrl: 'https://avatars.githubusercontent.com/u/2296' },
      ]) assert.equal(await confirm(wrong, origin, signal), false);
      for (const wrong of [
        'https://propr.example', 'http://127.0.0.1:41731', `${origin}/`,
        PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS[2],
      ]) assert.equal(await confirm(account, wrong, signal), false);
      assert.equal(await confirm(account, origin, AbortSignal.abort()), false);
      assert.equal(await confirm(account, origin, signal), true);
      assert.equal(await confirm(account, origin, signal), false);
    }
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    assert.match(main, /packagedAcceptanceAccountConfirmation\(packagedAcceptanceUserDataDirectory\)/);
    assert.match(main, /if \(acceptanceAccountConfirmation\) \{\s*return acceptanceAccountConfirmation\(account, origin, signal\);\s*\}\s*const result = await dialog.showMessageBox/);
    assert.match(main, /buttons: \['Cancel', `Save @\$\{account.username\}`\]/);
    assert.match(main, /return result.response === 1/);
  });
  it('accepts only the dual-trigger packaged Linux launch with an isolated profile', () => {
    assert.equal(authorizePackagedAcceptanceTest(input), acceptanceUserData);
    assert.equal(authorizePackagedAcceptanceTest({ ...input, argv: ['app'], environmentTriggered: false }), null);
  });

  it('fails closed for partial triggers, other platforms, and the default profile', () => {
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, environmentTriggered: false }), /both/);
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, platform: 'darwin' }), /Linux/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${defaultUserData}`],
    }), /must use/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${join(acceptanceUserData, '..', 'default')}`],
    }), /must use/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${join(dirname(acceptanceUserData), 'propr-desktop-acceptance-a1', '..', 'escaped')}`],
    }), /must use/);
  });

  it('supplies sleep and the shared clock only through the dual-authorized acceptance result', async () => {
    const authorizedDirectory = authorizePackagedAcceptanceTest(input);
    const timing = packagedAcceptancePairingTiming(authorizedDirectory);

    assert.ok(timing);
    assert.deepEqual(Object.keys(timing).sort(), ['now', 'sleep']);
    assert.equal(timing.now(), PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS);
    assert.equal(new Date(timing.now()).toISOString(), PACKAGED_ACCEPTANCE_TIME);
    assert.equal(PACKAGED_ACCEPTANCE_TIME, '2026-01-02T03:04:05.000Z');
    await timing.sleep(60_000);

    for (const mode of ['production', 'packaged smoke', 'ordinary runtime']) {
      assert.equal(packagedAcceptancePairingTiming(null), undefined, mode);
    }
    const untriggered = authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app'],
      environmentTriggered: false,
    });
    assert.equal(packagedAcceptancePairingTiming(untriggered), undefined);

    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    assert.match(
      main,
      /packagedAcceptancePairingTiming\(packagedAcceptanceUserDataDirectory\)/,
    );
    assert.match(main, /acceptancePairingTiming \? \{ pairingTiming: acceptancePairingTiming \} : \{\}/);
    assert.match(main, /packagedAcceptanceTest \? \{\s*reportWebSocketHandshake:/);
    assert.match(main, /desktop\.acceptance\.websocket_handshake/);
    assert.match(main, /desktop\.acceptance\.current_user_proxy/);
    assert.match(main, /packagedAcceptanceTest \? \{\s*reportNetworkPermissionDecision:/);
    assert.match(main, /desktop\.acceptance\.network_permission/);
    const acceptanceRunner = readFileSync(fileURLToPath(new URL('../scripts/run-packaged-acceptance.mjs', import.meta.url)), 'utf8');
    const currentUserClassifier = readFileSync(fileURLToPath(new URL(
      '../scripts/packaged-acceptance-current-user.mjs', import.meta.url,
    )), 'utf8');
    assert.match(acceptanceRunner, /'Access-Control-Allow-Private-Network': 'true'/);
    assert.match(acceptanceRunner, /network-permissions=/);
    assert.match(acceptanceRunner, /request\.url === '\/api\/auth\/demo-mode'\) return json\(response, 200, \{ demoMode: false \}\)/);
    const demoModeFixture = acceptanceRunner.indexOf("request.url === '/api/auth/demo-mode'");
    const genericApiFixture = acceptanceRunner.indexOf("request.url?.startsWith('/api/')");
    assert.ok(demoModeFixture >= 0 && demoModeFixture < genericApiFixture);
    assert.match(currentUserClassifier, /networkPermissionDecisionSummary/);
    assert.match(currentUserClassifier, /current-user-upstream-request-not-arrived/);
    assert.match(currentUserClassifier, /current-user-parsed-schema-rejected/);
  });

  it('bounds the dashboard Connected timeout diagnostic after flushing renderer evidence', () => {
    const acceptanceRunner = readFileSync(fileURLToPath(new URL('../scripts/run-packaged-acceptance.mjs', import.meta.url)), 'utf8');
    const dashboardStart = acceptanceRunner.indexOf("await runJourney('dashboard-profile-manager'");
    const dashboardEnd = acceptanceRunner.indexOf("await runJourney('offline'", dashboardStart);
    assert.notEqual(dashboardStart, -1);
    assert.notEqual(dashboardEnd, -1);
    const dashboardJourney = acceptanceRunner.slice(dashboardStart, dashboardEnd);

    assert.match(dashboardJourney, /await opener\.waitFor\(\{ timeout: 15_000 \}\)/);
    assert.match(dashboardJourney, /error instanceof Error\) \|\| error\.name !== 'TimeoutError'/);
    const flush = dashboardJourney.indexOf('await settlePendingRendererConsoleCaptures()');
    const diagnostic = dashboardJourney.indexOf('const diagnostic = {');
    const rethrow = dashboardJourney.indexOf('Acceptance dashboard Connected control timed out:');
    assert.ok(flush >= 0 && flush < diagnostic && diagnostic < rethrow);
    const diagnosticCatch = dashboardJourney.slice(
      dashboardJourney.indexOf('} catch (error)'),
      dashboardJourney.indexOf('    await waitForObserved'),
    );

    for (const boundedField of [
      'currentUserPhases: currentUserPhaseSummary(journey)',
      'networkPermissions: networkPermissionSummary(journey)',
      'currentUserCategory: currentUserValidationFailureCategory(journey)',
      'rendererLifecycleCategory: rendererLifecycleCategory(journey)',
      'rendererLifecycle: rendererLifecycleDiagnosticSummary(journey)',
      'surfacePhase: await rendererSurfacePhase(page)',
      'uiState: await rendererUiStateSummary(page)',
      'rendererErrors: rendererErrorCountSummary(journey)',
    ]) assert.ok(dashboardJourney.includes(boundedField), boundedField);
    assert.doesNotMatch(diagnosticCatch, /error\.(?:message|stack)|record\.(?:text|arguments|location|url)/);

    assert.match(
      acceptanceRunner,
      /const settlePendingRendererConsoleCaptures = async \(\) => \{[\s\S]*?await Promise\.allSettled\(unsettled\);[\s\S]*?\n\};/,
    );
    assert.match(acceptanceRunner, /const boundedAcceptanceDiagnosticCount = records => Math\.min\(records\.length, 9\)/);
    assert.match(acceptanceRunner, /if \(document\.querySelector\('\.desktop-app'\)\) return 'app'/);
    assert.match(acceptanceRunner, /if \(document\.querySelector\('\.desktop-entry'\)\) return 'entry'/);
    assert.match(acceptanceRunner, /return 'loading'/);

    const uiSummaryStart = acceptanceRunner.indexOf('const rendererUiStateSummary = async page =>');
    const uiSummaryEnd = acceptanceRunner.indexOf('\nconst rendererSurfacePhase', uiSummaryStart);
    assert.notEqual(uiSummaryStart, -1);
    assert.notEqual(uiSummaryEnd, -1);
    const uiSummary = acceptanceRunner.slice(uiSummaryStart, uiSummaryEnd);
    for (const status of ["'ready'", "'offline'", "'incompatible'", "'unknown'", "'absent'"]) {
      assert.ok(uiSummary.includes(status), status);
    }
    for (const labelCategory of [
      "'Connected: Operations'",
      "'Offline: Operations'",
      "'Update required: Operations'",
      "'other'",
    ]) assert.ok(uiSummary.includes(labelCategory), labelCategory);
    for (const booleanField of [
      'instanceSelectorPresent',
      'navigatorOnline',
      'redundantDesktopChromeAbsent',
      'routeLayoutPresent',
      'loadingSpinnerPresent',
      'validatedCurrentUserMarkerPresent',
      'dashboardMarkerPresent',
    ]) assert.ok(uiSummary.includes(booleanField), booleanField);
    assert.match(uiSummary, /document\.querySelector\('\.desktop-instance-selector-button'\)/);
    assert.match(uiSummary, /document\.querySelector\('\.desktop-titlebar'\) === null/);
    assert.match(uiSummary, /main\.mobile-content-clearance/);
    assert.match(uiSummary, /a\[href="\/admin\/members"\]/);
    assert.doesNotMatch(uiSummary, /outerHTML|innerHTML|document\.body\.textContent/);

    assert.match(acceptanceRunner, /const rendererLifecycleDiagnosticSummary = journey => \{[\s\S]*?invalidCount:[\s\S]*?firstInvalidCategory:[\s\S]*?invalidCategories:/);
    assert.match(
      acceptanceRunner,
      /recordCount: rendererLifecycleRecords\.filter\(record => record\.journey === journey\)\.length/,
    );
    assert.match(acceptanceRunner, /recordRendererLifecycleInvalid\(journey, \[/);
    assert.match(acceptanceRunner, /\.\.\.\(invalidCategory \? \[invalidCategory\] : \[\]\)/);
    assert.match(acceptanceRunner, /\.\.\.\(overflow \? \['overflow'\] : \[\]\)/);
    assert.match(acceptanceRunner, /rendererLifecycleInvalidStates\.has\(journey\)/);
    assert.match(acceptanceRunner, /if \(rendererLifecycleInvalidStates\.size > 0\)/);
    assert.match(acceptanceRunner, /firstInvalidCategory: firstInvalid\?\.firstCategory \?\? 'none'/);
    assert.doesNotMatch(acceptanceRunner, /rendererLifecycleEvidenceInvalid/);

    const errorSummaryStart = acceptanceRunner.indexOf(
      'const rendererConsoleErrorCategory = (record, expectedRevokedAuthorizationRecord) =>',
    );
    const errorSummaryEnd = acceptanceRunner.indexOf('\nconst rendererLifecycleDiagnosticSummary', errorSummaryStart);
    assert.notEqual(errorSummaryStart, -1);
    assert.notEqual(errorSummaryEnd, -1);
    const errorSummary = acceptanceRunner.slice(errorSummaryStart, errorSummaryEnd);
    for (const category of [
      'expectedRevokedAuthorizationResponse', 'currentUserSync', 'apiLoad', 'socketContext',
      'reactRuntime', 'networkResource', 'other', 'pageError',
    ]) {
      assert.ok(errorSummary.includes(category), category);
    }
    assert.match(errorSummary, /consoleErrorCategoryCounts: rendererConsoleErrorCategoryCounts\(rendererConsoleErrors, rendererPageErrors\)/);
    assert.match(errorSummary, /correlateExpectedRevokedAuthorizationConsoleRecord\(\{/);
    assert.match(acceptanceRunner, /rendererRequestOccurrence: source === 'renderer' \? authChecks : 0/);
    assert.match(errorSummary, /counts\[category\] = Math\.min\(counts\[category\] \+ 1, 9\)/);
    assert.doesNotMatch(errorSummary, /arguments|location|stack|url/);
    assert.match(acceptanceRunner, /if \(rendererErrors\.unexpectedErrors !== 0\)/);
    assert.match(acceptanceRunner, /unexpectedErrors: rendererErrors\.unexpectedErrors/);
  });

  it('keeps the shared clock subject to exact pairing expiry validation', () => {
    const timing = packagedAcceptancePairingTiming(authorizePackagedAcceptanceTest(input));
    assert.ok(timing);
    const response = {
      pairingId: `dpr_${'P'.repeat(22)}`,
      deviceSecret: 'D'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      interval: 1,
    };

    assert.equal(parseDesktopPairingStart({
      ...response,
      expiresAt: new Date(PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS + 60_000).toISOString(),
    }, 'https://propr.example.test', timing.now).expiresAt,
    '2026-01-02T03:05:05.000Z');
    assert.throws(() => parseDesktopPairingStart({
      ...response,
      expiresAt: PACKAGED_ACCEPTANCE_TIME,
    }, 'https://propr.example.test', timing.now), (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'invalid_response');
  });

  it('preserves only fixed secret-free handshake booleans through protected logging', () => {
    const evidence = {
      schemaVersion: 1,
      path: 'socket-io',
      transport: 'websocket',
      resource: 'websocket',
      scopeQueryPresent: true,
      scopeQueryCount: 1,
      scopeEqualsActive: true,
      activeBindingPresent: true,
      profileGenerationCurrent: true,
      originEqualsActive: true,
      rendererBearerPresent: false,
      rendererCookiePresent: false,
      outboundBearerPresent: true,
      bearerMainInjected: true,
      accepted: true,
      rejectionCategory: 'none',
    };
    assert.deepEqual(sanitizeDesktopLogFields('desktop.acceptance.websocket_handshake', evidence), evidence);
    assert.equal(JSON.stringify(evidence).includes('http'), false);
    assert.equal(JSON.stringify(evidence).includes('Bearer '), false);
  });
});
