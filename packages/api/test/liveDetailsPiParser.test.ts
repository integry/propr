import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/pi');
const fixture = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');

test('Pi JSON output is detected as its own stored output format', async () => {
  const { detectStoredOutputFormat } = await import('../routes/liveDetailsStoredOutputFormat.js');
  for (const name of ['pi-1.6.1-json-tool-task.jsonl', 'pi-1.6.1-json-codemode-mcp.jsonl', 'pi-1.6.1-json-scout-mcp.jsonl']) {
    assert.equal(detectStoredOutputFormat(fixture(name)), 'pi', name);
  }
  // A live stream that has not reached its session header yet.
  assert.equal(detectStoredOutputFormat('{"type":"turn_start"}\n'), 'pi');
  // A bare "session" record without Pi's header fields is not Pi.
  assert.equal(detectStoredOutputFormat('{"type":"session"}\n'), 'unknown');
});

test('the live view shows a codemode script and the MCP calls it made as readable tool events', async () => {
  const { parseStoredOutputContent } = await import('../routes/liveDetailsRoutes.js');
  const { parsed, format } = parseStoredOutputContent(fixture('pi-1.6.1-json-codemode-mcp.jsonl'));
  assert.equal(format, 'pi');
  const tools = parsed!.events.filter(event => event.type === 'tool_use').map(event => event.toolName);
  assert.deepEqual(tools, ['codemode', 'propr_repository/read_repository_file']);
  const results = parsed!.events.filter(event => event.type === 'tool_result');
  assert.equal(results.length, 2, 'one result for the nested MCP call and one for the script');
  assert.ok(parsed!.events.some(event => event.type === 'thought' && String(event.content).includes('FINAL ANSWER')));
});

test('the live view names a directly declared MCP tool <server>/<tool>', async () => {
  const { parseStoredOutputContent } = await import('../routes/liveDetailsRoutes.js');
  const { parsed } = parseStoredOutputContent(fixture('pi-1.6.1-json-scout-mcp.jsonl'));
  const use = parsed!.events.find(event => event.type === 'tool_use');
  assert.equal(use?.toolName, 'propr_repository/read_repository_file');
  assert.deepEqual(use?.input, { path: 'README.md' });
});
