import base from './playwright.config';
export default { ...base, reporter: 'list', use: { ...base.use, channel: 'chromium' } };
