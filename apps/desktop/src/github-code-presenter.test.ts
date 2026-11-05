import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubCodePresenter } from './github-code-presenter';
import { isSafeExternalUrl } from './security';
import { openAllowedExternalUrl } from './external-url';

const url = 'https://github.com/login/device';
test('real presenter opens verification URL through real external policy and copies only on native action', async () => {
  const controller = new AbortController();
  const opened: string[] = []; const copied: string[] = [];
  let dialogs = 0;
  assert.equal(isSafeExternalUrl(url), true);
  const present = createGithubCodePresenter({
    isShuttingDown: () => false,
    openExternal: value => openAllowedExternalUrl(value, async allowed => { opened.push(allowed); }),
    copy: value => copied.push(value),
    showDialog: async options => {
      dialogs++;
      assert.ok(options.buttons?.includes('Copy code'));
      assert.ok(options.buttons?.includes('Cancel sign-in'));
      if (dialogs === 1) return { response: 1 }; // copy before opening
      if (dialogs === 2) return { response: 0 }; // open
      if (dialogs === 3) return { response: 0 }; // copy while waiting
      return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: 1 }), { once: true }));
    },
  });
  const close = await present('fixture-code', url, controller.signal, () => controller.abort());
  await new Promise(resolve => setImmediate(resolve));
  await close();
  assert.deepEqual(opened, [url]); assert.deepEqual(copied, ['fixture-code', 'fixture-code']);
  assert.equal(controller.signal.aborted, false);
  await openAllowedExternalUrl('javascript:alert(1)', async value => { opened.push(value); });
  assert.deepEqual(opened, [url]);
});

test('late native Copy response after cancellation cannot touch clipboard or open browser', async () => {
  const controller = new AbortController();
  const present = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('late copy'), openExternal: async () => assert.fail('late browser'),
    showDialog: async () => { controller.abort(); return { response: 1 }; },
  });
  const close = await present('fixture-code', url, controller.signal, () => controller.abort());
  await close();
});

for (const waiting of [false, true]) test(`native Cancel sign-in aborts the attempt (${waiting ? 'waiting' : 'initial'} dialog)`, async () => {
  const controller = new AbortController(); let calls = 0; let opened = 0;
  const present = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('cancel must not copy'),
    openExternal: async () => { opened++; },
    showDialog: async () => ({ response: waiting ? (++calls === 1 ? 0 : 1) : 2 }),
  });
  const close = await present('fixture-code', url, controller.signal, () => controller.abort());
  await new Promise(resolve => setImmediate(resolve));
  await close();
  assert.equal(controller.signal.aborted, true); assert.equal(opened, waiting ? 1 : 0);
});

for (const failure of ['rejection', 'unsafe URL', 'shutdown', 'dialog rejection']) test(`browser action aborts with a failure reason on ${failure}`, async () => {
  const controller = new AbortController(); let opened = 0;
  const present = createGithubCodePresenter({
    isShuttingDown: () => failure === 'shutdown', copy: () => assert.fail('must not copy'),
    openExternal: async () => { opened++; throw new Error('private OS details'); },
    showDialog: async options => {
      if (failure === 'dialog rejection') throw new Error('private dialog details');
      if (controller.signal.aborted) return { response: 2 };
      if (opened) return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: 1 }), { once: true }));
      return { response: 0 };
    },
  });
  const close = await present('fixture-code', failure === 'unsafe URL' ? 'javascript:alert(1)' : url, controller.signal, reason => {
    assert.equal(reason, 'browser-failure');
    controller.abort(reason);
  });
  await new Promise(resolve => setImmediate(resolve));
  await close();
  assert.equal(controller.signal.reason, 'browser-failure');
  assert.equal(opened, failure === 'rejection' ? 1 : 0);
});

test('pending browser launch does not hold cleanup; late failure cannot cancel a closed prompt', async () => {
  const controller = new AbortController(); let rejectOpen!: (error: Error) => void;
  let dialogs = 0; let cancels = 0;
  const present = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('must not copy'),
    openExternal: () => new Promise((_, reject) => { rejectOpen = reject; }),
    showDialog: async options => {
      if (++dialogs === 1) return { response: 0 };
      return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: 1 }), { once: true }));
    },
  });
  const close = await present('fixture-code', url, controller.signal, () => { cancels++; controller.abort(); });
  await new Promise(resolve => setImmediate(resolve));
  await close(); await close();
  rejectOpen(new Error('late browser failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancels, 0);
  assert.equal(dialogs, 2);
});
