import { isAbsolute, resolve } from 'node:path';
import { probePackagedWindowsAuthorityHelper } from '../src/windows-update-authority';

const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3 || !isAbsolute(directory)) {
  throw new Error('Packaged Windows authority probe requires one absolute helper directory');
}
const stage = await probePackagedWindowsAuthorityHelper(resolve(directory));
if (stage !== 'READY') throw new Error(`Packaged Windows authority helper failed at ${stage}`);
process.stdout.write('Packaged Windows authority helper reached READY\n');
