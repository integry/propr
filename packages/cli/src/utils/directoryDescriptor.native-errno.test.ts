import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAt } from './directoryDescriptor.js';

// The Darwin identify path in connectIdentity opens children through the shipped
// addon's openAt and relies on `code === "ENOENT"` to recognise an absent child
// (first-time creation and `.ready-v1` resume) and on a failure for symlinked
// children. The addon maps errno to `code` in one shared C switch for every
// platform, so this Linux run pins that contract for the identical Darwin build.
// It does not replace the native rerun of localSetupDarwin.test.ts.
test('native openAt surfaces errno codes the pinned identity algorithm depends on', {
  skip: process.platform !== 'linux' && process.platform !== 'darwin' ? 'requires the native directory addon' : false,
}, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-native-errno-')));
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const dirfd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const expectCode = (name: string, codes: string[]) => {
      let thrown: unknown;
      try { closeSync(openAt(dirfd, name, flags)); } catch (error) { thrown = error; }
      assert.ok(thrown instanceof Error, `${name} must fail`);
      assert.ok(codes.includes((thrown as NodeJS.ErrnoException).code ?? ''), `${name}: ${String(thrown)}`);
      assert.equal((thrown as NodeJS.ErrnoException).code, (thrown as NodeJS.ErrnoException).code?.toUpperCase());
    };
    expectCode('public-instance-identity.json', ['ENOENT']);
    expectCode('.public-instance-identity.json.ready-v1', ['ENOENT']);

    writeFileSync(join(directory, 'identity-target'), '{}');
    symlinkSync(join(directory, 'identity-target'), join(directory, 'linked'));
    // Linux reports ELOOP; macOS also reports ELOOP for O_NOFOLLOW on a symlink.
    expectCode('linked', ['ELOOP']);
    symlinkSync('missing-target', join(directory, 'dangling'));
    expectCode('dangling', ['ELOOP']);

    mkdirSync(join(directory, 'child'));
    const childFd = openAt(dirfd, 'child', flags);
    try { assert.ok(fstatSync(childFd, { bigint: true }).isDirectory()); } finally { closeSync(childFd); }
    const fileFd = openAt(dirfd, 'identity-target', flags);
    try {
      const stat = fstatSync(fileFd, { bigint: true });
      assert.ok(stat.isFile());
      assert.equal(typeof stat.ino, 'bigint');
    } finally { closeSync(fileFd); }

    // O_NONBLOCK keeps a FIFO child from hanging the identify call.
    execFileSync('mkfifo', [join(directory, 'fifo')], { stdio: 'ignore' });
    const fifoFd = openAt(dirfd, 'fifo', flags);
    try { assert.ok(fstatSync(fifoFd).isFIFO()); } finally { closeSync(fifoFd); }
  } finally {
    closeSync(dirfd);
    rmSync(directory, { recursive: true, force: true });
  }
});
