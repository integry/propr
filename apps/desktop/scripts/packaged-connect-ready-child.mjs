import {
  createConnectReadyPublisher,
  createConnectReadyRecord,
} from './packaged-connect-ready.mjs';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) process.exit(2);

const expected = {
  platform: process.platform,
  arch: process.arch,
  authorityMechanism: 'inherited-standard-handle',
};
const result = createConnectReadyPublisher().publish(createConnectReadyRecord(expected), expected);
if (!result.ok) process.exit(3);
if (process.argv[2] === 'remain-alive') setInterval(() => undefined, 1000);
