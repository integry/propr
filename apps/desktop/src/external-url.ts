import { isSafeExternalUrl } from './security';

export async function openAllowedExternalUrl(url: string, open: (url: string) => Promise<void>, rejected: () => void = () => {}): Promise<void> {
  if (!isSafeExternalUrl(url)) { rejected(); return; }
  await open(url);
}
