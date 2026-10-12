export const SIGNED_RPM_ACCEPTANCE_CHECKS = Object.freeze([
  'configuredKeyOnly', 'nativeSignature', 'zypperInstall', 'rpmVerify', 'installedPayload', 'sourceManifest',
  'browserApproval', 'expectedAccount', 'activation', 'authenticatedUi', 'persistedCredential',
  'logoutRevocation', 'rejection', 'timeout', 'wrongAccount', 'narrowWindow', 'zoom200', 'keyboardFocus',
]);

export const validateSignedRpmAcceptanceEvidence = (evidence, expected) => {
  const keys = ['schemaVersion', 'status', 'sourceRevision', 'rpmSha256', 'signingRunId', 'fingerprint', 'target', 'checks'];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || Object.keys(evidence).sort().join() !== keys.sort().join()
    || evidence.schemaVersion !== 1 || evidence.status !== 'passed' || evidence.target !== 'linux-x64-rpm-opensuse'
    || !/^[a-f0-9]{40}$/.test(evidence.sourceRevision) || !/^[a-f0-9]{64}$/.test(evidence.rpmSha256)
    || !/^[1-9][0-9]*$/.test(evidence.signingRunId) || !/^[A-F0-9]{40}$/.test(evidence.fingerprint)
    || ['sourceRevision', 'rpmSha256', 'signingRunId', 'fingerprint'].some(key => evidence[key] !== expected[key])
    || !evidence.checks || Object.keys(evidence.checks).sort().join() !== [...SIGNED_RPM_ACCEPTANCE_CHECKS].sort().join()
    || SIGNED_RPM_ACCEPTANCE_CHECKS.some(key => evidence.checks[key] !== true)) {
    throw new Error('Missing, failed, or mismatched installed signed RPM acceptance evidence');
  }
  return evidence;
};

export const readSignedRpmEvidenceZip = async bytes => {
  const { inflateRawSync, crc32 } = await import('node:zlib');
  const fail = () => { throw new Error('Invalid authoritative signed RPM acceptance archive'); };
  if (bytes.length < 22 || bytes.length > 65536) fail();
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) !== 0
    || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== 1
    || bytes.readUInt16LE(end + 10) !== 1 || bytes.readUInt16LE(end + 20) !== 0) fail();
  const directory = bytes.readUInt32LE(end + 16);
  if (directory + 46 > end || directory + bytes.readUInt32LE(end + 12) !== end
    || bytes.readUInt32LE(directory) !== 0x02014b50) fail();
  const method = bytes.readUInt16LE(directory + 10);
  const flags = bytes.readUInt16LE(directory + 8);
  const compressed = bytes.readUInt32LE(directory + 20);
  const size = bytes.readUInt32LE(directory + 24);
  const nameLength = bytes.readUInt16LE(directory + 28);
  const extraLength = bytes.readUInt16LE(directory + 30);
  const commentLength = bytes.readUInt16LE(directory + 32);
  const local = bytes.readUInt32LE(directory + 42);
  if ((flags & 1) || ![0, 8].includes(method) || size === 0 || size > 16384
    || directory + 46 + nameLength + extraLength + commentLength !== end
    || bytes.subarray(directory + 46, directory + 46 + nameLength).toString() !== 'signed-rpm-acceptance.json'
    || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50
    || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
  const localName = bytes.readUInt16LE(local + 26);
  const start = local + 30 + localName + bytes.readUInt16LE(local + 28);
  if (start + compressed > directory || bytes.subarray(local + 30, local + 30 + localName).toString() !== 'signed-rpm-acceptance.json') fail();
  const payload = bytes.subarray(start, start + compressed);
  const contents = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: 16384 });
  if (contents.length !== size || crc32(contents) !== bytes.readUInt32LE(directory + 16)) fail();
  return JSON.parse(contents.toString('utf8'));
};

// Publication retrieves the authoritative Actions artifact itself. A locally
// forged passed JSON, even with a real signing-run ID, cannot authorize release.
export const verifySignedRpmEvidenceArtifact = async ({ json, request, signingRunId, evidence }) => {
  const { createHash } = await import('node:crypto');
  const { isDeepStrictEqual } = await import('node:util');
  const matches = [];
  for (let page = 1; ; page++) {
    const result = await json(`/actions/runs/${signingRunId}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result?.artifacts)) throw new Error('Invalid signing-run acceptance artifact list');
    matches.push(...result.artifacts.filter(artifact => artifact.name === `propr-desktop-installed-signed-rpm-${signingRunId}`));
    if (result.artifacts.length < 100) break;
  }
  const artifact = matches[0];
  if (matches.length !== 1 || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired !== false
    || String(artifact.workflow_run?.id) !== signingRunId
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 65536
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')) {
    throw new Error('Missing, expired, or invalid authoritative signed RPM acceptance artifact');
  }
  const response = await request(`/actions/artifacts/${artifact.id}/zip`, { headers: { Accept: 'application/octet-stream' } });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 65536) throw new Error('Oversized authoritative signed RPM acceptance artifact');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) {
    throw new Error('Authoritative signed RPM acceptance archive digest mismatch');
  }
  if (!isDeepStrictEqual(await readSignedRpmEvidenceZip(bytes), evidence)) {
    throw new Error('Local acceptance evidence differs from authoritative signing-run evidence');
  }
};
