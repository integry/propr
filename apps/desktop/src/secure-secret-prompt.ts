import { spawn } from 'node:child_process';

const commands = [
  { command: 'zenity', args: ['--password', '--title=ProPR Desktop', '--text=Enter the GitHub webhook signing secret'] },
  { command: 'kdialog', args: ['--password', 'Enter the GitHub webhook signing secret', '--title', 'ProPR Desktop'] },
];

const runPrompt = ({ command, args }: typeof commands[number], signal?: AbortSignal): Promise<{ unavailable: boolean; value: string | null }> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = Buffer.alloc(0);
  let settled = false;
  const finish = (action: () => void) => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); action(); } };
  const abort = () => { child.kill('SIGKILL'); finish(() => reject(Object.assign(new Error('Secret prompt cancelled'), { name: 'AbortError' }))); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]); if (output.length > 2048) child.kill('SIGKILL'); });
  child.once('error', error => finish(() => (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? resolve({ unavailable: true, value: null }) : reject(new Error('The native secret prompt failed.'))));
  child.once('close', code => finish(() => {
    if (code === 1) return resolve({ unavailable: false, value: null });
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (code !== 0 || value.length < 16 || value.length > 512 || /[\0\r\n]/.test(value)) return reject(new Error('The native secret prompt failed.'));
    resolve({ unavailable: false, value });
  }));
});

export async function promptForWebhookSecret(signal?: AbortSignal): Promise<string | null> {
  for (const command of commands) {
    const result = await runPrompt(command, signal);
    if (!result.unavailable) return result.value;
  }
  throw new Error('Install zenity or kdialog to enter a webhook secret securely.');
}
