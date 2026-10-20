import base from './playwright.config';
export default { ...base, testDir: '/home/node/workspace/propr-ui/e2e', use: { ...base.use, browserName: 'webkit' as const } };
