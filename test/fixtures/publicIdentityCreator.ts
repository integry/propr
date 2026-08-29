import { getOrCreatePublicInstanceIdentity as getCliIdentity } from '../../packages/cli/src/connectIdentity.js';
import { getOrCreatePublicInstanceIdentity as getApiIdentity } from '../../packages/api/publicInstanceIdentity.js';

const [kind, data, identity] = process.argv.slice(2);
if ((kind !== 'cli' && kind !== 'api') || !data || !identity) process.exit(64);
const value = kind === 'cli'
  ? getCliIdentity(data, () => identity)
  : getApiIdentity(data, () => identity);
process.stdout.write(`${value}\n`);
