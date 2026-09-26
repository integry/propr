import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { DESKTOP_HELP_URLS } from './native-commands';

/** Public build diagnostics only. Never include profile paths or credentials. */
export const applicationAboutDetails = (version: string, platform: string, arch: string, versions: NodeJS.ProcessVersions): string => [
  `ProPR ${version}`,
  `Platform: ${platform} (${arch})`,
  `Electron: ${versions.electron ?? 'unknown'}`,
  `Chromium: ${versions.chrome ?? 'unknown'}`,
  `Node.js: ${versions.node}`,
  '',
  `© ${new Date().getFullYear()} Rinalds Uzkalns`,
  DESKTOP_HELP_URLS.website,
].join('\n');

export const showApplicationAbout = async (host: {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  copy(text: string): void;
  openExternal(url: string): Promise<void>;
}, details: string): Promise<void> => {
  const { response } = await host.showMessageBox({
    type: 'info', title: 'About ProPR', message: 'ProPR',
    detail: `ProPR is an AI-powered development workspace for planning, running, and reviewing coding tasks across your repositories.\n\n${details}`,
    buttons: ['Close', 'Copy Version Details', 'Open ProPR Website'], defaultId: 0, cancelId: 0,
  });
  if (response === 1) host.copy(details);
  if (response === 2) await host.openExternal(DESKTOP_HELP_URLS.website);
};
