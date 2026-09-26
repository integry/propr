import { parseDesktopGitHubAccount, type DesktopGitHubAccount } from './shared/github-account';

/** Bound untrusted identity response bodies as well as their headers. */
export const readAccountResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<DesktopGitHubAccount | null> => {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  let onAbort = () => {};
  try {
    if (!response.ok || deadline.aborted) return null;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Account validation cancelled'));
      deadline.addEventListener('abort', onAbort, { once: true });
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseDesktopGitHubAccount(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  } finally {
    deadline.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
};
