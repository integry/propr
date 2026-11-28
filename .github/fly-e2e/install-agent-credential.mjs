// Installs one agent credential file into its store on the volume, the way an operator does (see
// setup-fly.md). Run over `fly ssh console` after agent-credential-store.mjs, with __AGENT__,
// __KEY__ (the base64 env key) and __FILE__ (the file name in the store) substituted. Prints the
// installed file's byte count.
const { chmod, mkdir, rename, rm, stat, writeFile } = await import('node:fs/promises');
const { randomUUID } = await import('node:crypto');
const { join } = await import('node:path');
const { dir, env } = await agentCredentialStore('__AGENT__');
const encoded = env.get('__KEY__');
if (!encoded) throw new Error(`__KEY__ is unset in the app environment (${env.source}) and this session`);
const content = Buffer.from(encoded, 'base64');
if (!content.length) throw new Error('__KEY__ decoded to an empty file');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const file = join(dir, '__FILE__');
const temp = join(dir, `.credential-${randomUUID()}`);
try {
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
  await rename(temp, file);
} finally {
  await rm(temp, { force: true });
}
const { size } = await stat(file);
if (!size) throw new Error('Installed __FILE__ is empty');
console.log(size);
