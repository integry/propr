import base from './playwright.config';
export default { ...base, reporter: 'list', use: { ...base.use, browserName: 'webkit' as const } };
