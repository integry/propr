import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  verifyMacApplicationIcon,
  verifyPackagedLinuxIcon,
  verifyPackagedTrayIcon,
} from './desktop-icon-assets.mjs';

const execFile = promisify(execFileCallback);
const [platform, suppliedApplicationRoot] = process.argv.slice(2);
if (!['linux', 'darwin'].includes(platform) || !suppliedApplicationRoot || process.argv.length !== 4) {
  throw new Error('Usage: verify-packaged-desktop-icon.mjs <linux|darwin> <application-root>');
}
const applicationRoot = resolve(suppliedApplicationRoot);

if (platform === 'linux') {
  await verifyPackagedLinuxIcon(applicationRoot);
  await verifyPackagedTrayIcon(resolve(applicationRoot, 'resources'));
} else {
  const plist = resolve(applicationRoot, 'Contents', 'Info.plist');
  const readPlist = async key => {
    const { stdout } = await execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
    return stdout.trim();
  };
  await verifyMacApplicationIcon({ applicationRoot, readPlist });
  await verifyPackagedTrayIcon(resolve(applicationRoot, 'Contents', 'Resources'));
}
console.log(`Packaged ${platform} desktop icon passed native metadata and asset verification.`);
