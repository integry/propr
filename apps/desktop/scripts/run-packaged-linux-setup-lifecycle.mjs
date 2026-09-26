import { runPackagedLinuxSetupLifecycle } from './packaged-linux-setup-lifecycle.mjs';

const report = await runPackagedLinuxSetupLifecycle();
console.log(report.result === 'verified'
  ? `Packaged Linux setup lifecycle verified at ${report.sourceSha}: cancellation, fresh retry, interrupted relaunch, and cleanup passed.`
  : `Packaged Linux setup lifecycle unverified at ${report.sourceSha}: ${report.unverifiedPhase}. ${report.limitations.join(' ')}`);
