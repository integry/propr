// Installed in the qualified task image. No shell, host files or ambient MCP catalog.
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
let config;
try { config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString()); } catch { process.exit(1); }
const secrets = Object.values(config.secretEnv).map(key => process.env[key]).filter(Boolean);
const variants = secrets.flatMap(s => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex'), encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
const redact = value => {
  if (typeof value === 'string') return variants.reduce((s, secret) => s.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redact(v)]));
  return value;
};
// Executables are operator-fixed and must already exist in the image.
let executable;
try { executable = await realpath(config.executable); if (!(await lstat(executable)).isFile()) process.exit(1); } catch { process.exit(1); }
const child = spawn(executable, config.args, { shell: false, env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(k => process.env[k]).map(k => [k, process.env[k]])), ...Object.fromEntries(Object.entries(config.secretEnv).map(([field, key]) => [field, process.env[key]])) }, stdio: ['pipe', 'pipe', 'ignore'] });
let calls = 0, bytes = 0, sequence = 0;
const pending = new Map();
const send = value => { const line = JSON.stringify(redact(value)); bytes += Buffer.byteLength(line); if (bytes > 16 * 1024 * 1024) stop(); else process.stdout.write(line + '\n'); };
const stop = () => { child.kill('SIGKILL'); process.exit(0); };
child.on('error', stop); child.on('exit', () => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
// Bound buffered data before readline can allocate an unbounded line.
const lines = (stream, limit, run) => {
  let size = 0;
  stream.on('data', chunk => { for (const byte of chunk) { size = byte === 10 ? 0 : size + 1; if (size > limit) stop(); } });
  const reader = createInterface({ input: stream }); reader.on('line', line => { try { run(JSON.parse(line)); } catch { stop(); } });
  return reader;
};
lines(process.stdin, 64 * 1024, rpc => {
  if (++calls > 256) return stop();
  const method = rpc.method;
  const valid = rpc.jsonrpc === '2.0' && Object.keys(rpc).every(k => ['jsonrpc', 'id', 'method', 'params'].includes(k)) && ['initialize', 'ping', 'notifications/initialized', 'tools/list', 'tools/call'].includes(method) && (rpc.id === undefined || typeof rpc.id === 'string' || typeof rpc.id === 'number');
  const permitted = method !== 'tools/call' || (rpc.params && config.tools.includes(rpc.params.name) && Object.keys(rpc.params).every(k => ['name', 'arguments', '_meta'].includes(k)));
  if (!valid || !permitted || (rpc.id !== undefined && [...pending.values()].some(request => request.id === rpc.id))) { if (rpc.id !== undefined) send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'MCP capability unavailable' } }); return; }
  if (rpc.id !== undefined && pending.size >= 4) { send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'MCP concurrency limit reached' } }); return; }
  if (rpc.id !== undefined) {
    // Timed-out replies cannot satisfy a later request reusing a client ID.
    const id = rpc.id, upstreamId = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(upstreamId);
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'MCP request timed out' } });
    }, 10_000);
    pending.set(upstreamId, { id, method, timer });
    rpc.id = upstreamId;
  }
  if (method === 'tools/call') rpc.params = { name: rpc.params.name, arguments: rpc.params.arguments };
  child.stdin.write(JSON.stringify(rpc) + '\n');
});
process.stdin.on('end', stop);
lines(child.stdout, 1024 * 1024, rpc => {
  const request = pending.get(rpc.id);
  if (!request || rpc.jsonrpc !== '2.0') return;
  if (rpc.error && typeof rpc.error === 'object' && Number.isInteger(rpc.error.code)) {
    clearTimeout(request.timer); pending.delete(rpc.id);
    // Preserve the protocol code without disclosing upstream messages or data.
    send({ jsonrpc: '2.0', id: request.id, error: { code: rpc.error.code, message: 'MCP request failed' } });
    return;
  }
  if (!Object.hasOwn(rpc, 'result') || rpc.error) return;
  clearTimeout(request.timer); pending.delete(rpc.id);
  let result = rpc.result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: config.name, version: '1' } };
  if (request.method === 'tools/list') { if (!Array.isArray(result?.tools) || result.tools.length > 64) return stop(); result = { tools: result.tools.filter(t => config.tools.includes(t.name)) }; }
  send({ jsonrpc: '2.0', id: request.id, result });
});
