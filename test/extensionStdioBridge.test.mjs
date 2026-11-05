import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

test('stdio errors release requests and concurrency rejection preserves pending calls and server lifetime', async t => {
  const code = `const held=[]; require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const rpc=JSON.parse(line);
    const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
    if(rpc.id===1) console.log(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32602,message:process.env.API_KEY,data:{secret:process.env.API_KEY}}}));
    else if(rpc.method==='tools/call') held.push(rpc.id);
    else if(rpc.method==='notifications/initialized') { for(const id of held.splice(0))send(id,{}); }
    else send(rpc.id,{});
  });`;
  const config = Buffer.from(JSON.stringify({ name: 'synthetic', executable: '/usr/bin/env', args: [process.execPath, '-e', code], tools: ['lookup'], secretEnv: { API_KEY: 'SYNTHETIC_SECRET' } })).toString('base64url');
  const child = spawn(process.execPath, [path.resolve('scripts/extension-stdio-bridge.mjs'), config], { env: { SYNTHETIC_SECRET: 'SENTINEL_PRIVATE_ERROR' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout }); const pending = new Map();
  reader.on('line', line => { const rpc = JSON.parse(line); pending.get(rpc.id)?.(rpc); pending.delete(rpc.id); });
  t.after(async () => { reader.close(); if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('close', r)); } });
  const call = (id, method = 'ping') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No reply for ${id}`)), 4000);
    pending.set(id, rpc => { clearTimeout(timer); resolve(rpc); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(method === 'tools/call' ? { params: { name: 'lookup', arguments: {} } } : {}) }) + '\n');
  });
  assert.deepEqual(await call(1), { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'MCP request failed' } });
  const held = [2, 3, 4, 5].map(id => call(id, 'tools/call'));
  assert.deepEqual(await call(6, 'tools/call'), { jsonrpc: '2.0', id: 6, error: { code: -32000, message: 'MCP concurrency limit reached' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await Promise.all(held)).map(r => r.id), [2, 3, 4, 5]);
  await new Promise(r => setTimeout(r, 10_100)); // A leaked error timer would kill the server here.
  assert.deepEqual(await call(7), { jsonrpc: '2.0', id: 7, result: {} });
});

test('stdio timeout releases one request, ignores its late reply and permits reuse of the client ID', async t => {
  const code = `let first=true; require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const rpc=JSON.parse(line); const slow=first; first=false;
    setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{slow}})),slow?10500:1000);
  });`;
  const config = Buffer.from(JSON.stringify({ name: 'timeout', executable: '/usr/bin/env', args: [process.execPath, '-e', code], tools: [], secretEnv: {} })).toString('base64url');
  const child = spawn(process.execPath, [path.resolve('scripts/extension-stdio-bridge.mjs'), config]);
  const reader = createInterface({ input: child.stdout });
  const replies = []; let notify;
  reader.on('line', line => { replies.push(JSON.parse(line)); notify?.(); });
  t.after(async () => { reader.close(); child.kill(); await new Promise(r => child.once('close', r)); });
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No bridge reply')), 12000);
    notify = () => { clearTimeout(timer); notify = undefined; resolve(replies.shift()); };
    if (replies.length) notify();
  });
  const send = () => child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:'reused',method:'ping'})+'\n');
  send();
  assert.deepEqual(await next(), {jsonrpc:'2.0',id:'reused',error:{code:-32000,message:'MCP request timed out'}});
  send();
  assert.deepEqual(await next(), {jsonrpc:'2.0',id:'reused',result:{slow:false}});
  send();
  assert.deepEqual(await next(), {jsonrpc:'2.0',id:'reused',result:{slow:false}});
});
