import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { requestDesktopMicrophoneConsent } from './microphone-consent';

function fixture(platform: NodeJS.Platform = 'darwin') {
  const controller = new AbortController();
  const confirm = mock.fn(async () => true);
  const askForMacAccess = mock.fn(async () => true);
  return { controller, options: { platform, signal: controller.signal, confirm, askForMacAccess } };
}

describe('desktop microphone consent', () => {
  it('requires the native choice before macOS permission and asks only for an explicit check', async () => {
    const { options } = fixture();
    assert.equal(options.confirm.mock.callCount(), 0);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
    options.askForMacAccess.mock.mockImplementation(async () => {
      assert.equal(options.confirm.mock.callCount(), 1);
      return true;
    });
    assert.equal(await requestDesktopMicrophoneConsent(options), true);
    assert.equal(options.askForMacAccess.mock.callCount(), 1);
  });
  it('does not ask macOS when native consent is denied', async () => {
    const { options } = fixture();
    options.confirm.mock.mockImplementation(async () => false);
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
  });
  it('preserves OS denial', async () => {
    const { options } = fixture();
    options.askForMacAccess.mock.mockImplementation(async () => false);
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
  });
  it('does not open a prompt for an already cancelled check', async () => {
    const { options, controller } = fixture();
    controller.abort();
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
    assert.equal(options.confirm.mock.callCount(), 0);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
  });
  it('rejects late native approval before requesting macOS permission', async () => {
    const { options, controller } = fixture();
    options.confirm.mock.mockImplementation(async () => { controller.abort(); return true; });
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
  });
  it('rejects late macOS approval after cancellation', async () => {
    const { options, controller } = fixture();
    options.askForMacAccess.mock.mockImplementation(async () => { controller.abort(); return true; });
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
  });
  it('uses native consent on Linux without invoking macOS APIs', async () => {
    const { options } = fixture('linux');
    assert.equal(await requestDesktopMicrophoneConsent(options), true);
    assert.equal(options.confirm.mock.callCount(), 1);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
  });
  it('does not enable deferred platforms', async () => {
    const { options } = fixture('win32');
    assert.equal(await requestDesktopMicrophoneConsent(options), false);
    assert.equal(options.confirm.mock.callCount(), 0);
    assert.equal(options.askForMacAccess.mock.callCount(), 0);
  });
});
