import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Docker process helpers live apart from agentLoginDocker.ts so modules that only
// resolve credential paths (for example the credential store) never load child_process.
export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export function defaultRunDocker(args: string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const timeout = args[0] === 'pull' ? 5 * 60_000 : 30_000;
    execFile('docker', args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function defaultSpawnDocker(args: string[]): ChildProcessWithoutNullStreams {
  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = ['docker', ...args].map(shellQuote).join(' ');
  // Docker refuses to attach a container TTY when its own stdin is a pipe.
  // script(1) supplies the controlling PTY while keeping Node's stdin/stdout
  // pipeable for the browser session.
  return spawn('script', ['-qefc', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
}
