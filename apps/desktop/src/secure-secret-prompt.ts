import { spawn } from 'node:child_process';
import { isValidWebhookSecret } from './webhook-secret-policy';

interface PromptCommand {
  command: string;
  args: string[];
}

const commands: PromptCommand[] = [
  { command: 'zenity', args: ['--password', '--title=ProPR Desktop', '--text=Enter the GitHub webhook signing secret'] },
  { command: 'kdialog', args: ['--password', 'Enter the GitHub webhook signing secret', '--title', 'ProPR Desktop'] },
];

const runPrompt = ({ command, args }: PromptCommand, signal?: AbortSignal): Promise<{ unavailable: boolean; value: string | null }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = Buffer.alloc(0);
    const abort = () => {
      child.kill('SIGKILL');
      reject(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('The native secret prompt was cancelled.'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => signal?.removeEventListener('abort', abort));
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 2048) child.kill('SIGKILL');
    });
    child.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve({ unavailable: true, value: null });
      else reject(new Error('The native secret prompt failed.'));
    });
    child.once('close', code => {
      if (code === 1) return resolve({ unavailable: false, value: null });
      if (code !== 0 || output.length > 2048) return reject(new Error('The native secret prompt failed.'));
      const value = output.toString('utf8').replace(/[\r\n]+$/, '');
      if (!isValidWebhookSecret(value)) return reject(new Error('The native secret prompt returned an invalid value.'));
      resolve({ unavailable: false, value });
    });
  });

/** Acquire a one-shot secret in Electron main without sending its bytes through renderer IPC. */
export async function promptForWebhookSecret(signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  for (const command of commands) {
    const result = await runPrompt(command, signal);
    signal?.throwIfAborted();
    if (!result.unavailable) return result.value;
  }
  throw new Error('No supported native secret prompt is installed. Install zenity or kdialog and try again.');
}
