// Protected credential check for the stored Linux signing key pair. It proves the
// private key and passphrase make a SHA256 signature that the pinned public export
// verifies. It never reads, builds, signs, installs or publishes a package/release.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signMetadata, verifyMetadata } from './linux-package-auth.mjs';
import { OWNER_FINGERPRINT, requireRpmIdentity, rpmIdentityFromEnvironment } from './rpm-signing.mjs';

export const VERIFY_KEY_OPERATION = 'verify-key';
export const VERIFY_KEY_RECEIPT_KIND = 'propr-desktop-linux-signing-key-verification';
// Fixed, disposable and nonsecret. It is never a release asset or package input.
export const VERIFY_KEY_CHALLENGE = 'ProPR Desktop Linux signing-key verification challenge v1\n'
  + 'This fixed nonsecret text proves possession of the stored key pair only.\n'
  + 'It is not a package, checksum, repository index or release asset.\n';
export const PINNED_PUBLIC_EXPORT = fileURLToPath(new URL('../../../docs/static/keys/propr-desktop-release.asc', import.meta.url));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

// GnuPG agents started for a temporary home carry `--homedir <home>`. Find our own
// survivors by path only; never inspect or signal the operator's agents.
async function ownedProcesses(root) {
  const owned = [];
  let entries;
  try { entries = await readdir('/proc'); } catch { throw new Error('Cannot confirm signing-key verification cleanup'); }
  for (const entry of entries.filter(name => /^[1-9][0-9]*$/.test(name) && Number(name) !== process.pid)) {
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    if (cmdline.split('\0').some(argument => argument === root || argument.startsWith(`${root}/`))) owned.push(Number(entry));
  }
  return owned;
}

export async function confirmCleanup(root, homes) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const owned = await ownedProcesses(root);
    if (!owned.length) break;
    for (const pid of owned) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    await sleep(100);
  }
  if ((await ownedProcesses(root)).length) throw new Error('Signing-key verification left a temporary GnuPG process running');
  // withKey removes every temporary GnuPG home, including imported secret material.
  if ((await readdir(homes)).length) throw new Error('Signing-key verification left a temporary GnuPG home behind');
}

export async function signChallenge({ directory, identity, privateKey, passphrase }) {
  const challenge = join(directory, 'challenge.txt');
  const signature = join(directory, 'challenge.txt.asc');
  await writeFile(challenge, VERIFY_KEY_CHALLENGE, { mode: 0o600, flag: 'wx' });
  // Fresh 0700 home: pinned RSA/validity checks, exact secret primary fingerprint,
  // loopback passphrase file, SHA256 detached signature, then public-only verify.
  await signMetadata({ path: challenge, output: signature, identity, privateKey, passphrase });
  return { challenge, signature };
}

// Independent verification in another fresh public-only home. A missing, malformed,
// non-SHA256, wrong-key, expired or revoked signature fails.
export async function verifyChallenge({ challenge, signature, identity }) {
  requireRpmIdentity(identity);
  if (await readFile(challenge, 'utf8') !== VERIFY_KEY_CHALLENGE) throw new Error('Signing-key challenge was altered');
  await verifyMetadata({ path: challenge, signature, identity });
}

export async function verifySigningKey({ identity, pinnedPublicKey, privateKey, passphrase }) {
  requireRpmIdentity(identity);
  const pinned = requireRpmIdentity({ fingerprint: identity.fingerprint, publicKey: pinnedPublicKey });
  const root = await mkdtemp(join(tmpdir(), 'propr-verify-key-'));
  const homes = join(root, 'homes');
  const work = join(root, 'work');
  const savedTmpdir = process.env.TMPDIR;
  let result;
  let failure;
  try {
    await mkdir(homes, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    // Every withKey home is created below this owned root so cleanup is provable.
    process.env.TMPDIR = homes;
    const { challenge, signature } = await signChallenge({ directory: work, identity, privateKey, passphrase });
    await verifyChallenge({ challenge, signature, identity: pinned });
    result = { challengeSha256: sha256(await readFile(challenge)), signatureSha256: sha256(await readFile(signature)) };
  } catch (error) {
    failure = error;
  }
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  // Cleanup must be proven even after a failed check; an interrupted cleanup is never success.
  try {
    await confirmCleanup(root, homes);
  } catch (error) {
    failure ??= error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return result;
}

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function verifyKeyReceipt({ repository, workflowRunId, controlRevision, sourceRevision, fingerprint,
  challengeSha256, signatureSha256, verifiedAt = new Date().toISOString() }) {
  if (!REPOSITORY.test(repository ?? '') || !RUN_ID.test(workflowRunId ?? '')
    || !SHA.test(controlRevision ?? '') || !SHA.test(sourceRevision ?? '')
    || !/^[A-F0-9]{40}$/.test(fingerprint ?? '')
    || challengeSha256 !== sha256(VERIFY_KEY_CHALLENGE) || !/^[a-f0-9]{64}$/.test(signatureSha256 ?? '')) {
    throw new Error('Invalid signing-key verification receipt inputs');
  }
  return {
    schemaVersion: 1,
    kind: VERIFY_KEY_RECEIPT_KIND,
    operation: VERIFY_KEY_OPERATION,
    repository,
    workflowRunId,
    controlRevision,
    // Identity metadata only; the frozen source is neither checked out nor executed.
    sourceRevision,
    fingerprint,
    challengeSha256,
    signatureSha256,
    digestAlgorithm: 'SHA256',
    checks: {
      publicKeyMatchesOwnerPin: true,
      privateKeyPrimaryFingerprint: true,
      passphraseSignedChallenge: true,
      independentPinnedExportVerification: true,
      temporaryHomesAndAgentsCleaned: true,
    },
    verifiedAt,
  };
}

const option = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1 || args.indexOf(name, index + 1) !== -1) throw new Error(`Expected exactly one ${name}`);
  return args[index + 1];
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Capture before any await or subprocess can inherit them.
  const privateKey = process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
  const passphrase = process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
  delete process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
  delete process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
  try {
    const args = process.argv.slice(2);
    if (args.shift() !== VERIFY_KEY_OPERATION || args.length !== 10) {
      throw new Error('Expected verify-key --repository OWNER/NAME --workflow-run-id ID --control-revision SHA --source-revision SHA --output PATH');
    }
    const output = resolve(option(args, '--output'));
    const metadata = {
      repository: option(args, '--repository'),
      workflowRunId: option(args, '--workflow-run-id'),
      controlRevision: option(args, '--control-revision'),
      sourceRevision: option(args, '--source-revision'),
    };
    // Strict production pin: the environment fingerprint must equal OWNER_FINGERPRINT.
    const identity = rpmIdentityFromEnvironment();
    if (identity.fingerprint !== OWNER_FINGERPRINT) throw new Error('Release identity differs from owner pin');
    const pinnedPublicKey = await readFile(PINNED_PUBLIC_EXPORT, 'utf8');
    const digests = await verifySigningKey({ identity, pinnedPublicKey, privateKey, passphrase });
    const receipt = verifyKeyReceipt({ ...metadata, fingerprint: identity.fingerprint, ...digests });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    console.log(`Signing-key verification succeeded: ${identity.fingerprint}`);
  } catch (error) {
    // Messages are fixed strings from reviewed code; subprocess output is never forwarded.
    console.error(`Signing-key verification failed: ${String(error?.message ?? error).slice(0, 300)}`);
    process.exitCode = 1;
  }
}
