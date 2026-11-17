import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import { PLUGIN_API_BASE, type PluginDetail, type PluginView } from "@propr/shared";
import { ApiClient } from "../api/client.js";
import { getPlugin, listPlugins, pluginPath } from "../api/plugins.js";
import type { ConfigManager } from "../config/index.js";
import { createPluginCommand, formatPluginDetail, formatPluginTable, pluginStateLabel, runPluginList, runPluginShow } from "./pluginCommands.js";

const manifest = (id: string, name: string, overrides: Partial<NonNullable<PluginView["manifest"]>> = {}): NonNullable<PluginView["manifest"]> => ({
  id, name, description: `${name} for ProPR.`, version: "1.0.0", category: "messaging", homepage: `https://example.com/${id}`,
  permissions: [{ name: "events.read", description: "Receive ProPR task, pull request and automation events" }],
  connections: [], settings: { type: "object", properties: {}, required: [] }, outboundHosts: ["hooks.example.com"], outboundHostsFromSettings: [],
  contributes: { mcpServers: [], skills: [], automationTemplates: [], commands: [], subscriptions: ["pull_request.merged"], webhooks: [] },
  ...overrides,
});

const available: PluginView = {
  id: "slack", available: true, manifest: manifest("slack", "Slack"), state: "available", installation: null, connections: [],
  needsApproval: false, pendingPermissions: [], pendingAcknowledgements: [], enableBlockers: [],
};
const enabled: PluginView = {
  ...available, id: "linear", manifest: manifest("linear", "Linear", { category: "issue-tracking", version: "1.2.0" }), state: "enabled",
  installation: {
    installedVersion: "1.1.0", enabled: true, settings: {}, repositories: ["acme/app", "acme/api"], grantedPermissions: ["events.read"], acknowledgements: {},
    installedBy: "admin", installedAt: Date.UTC(2026, 10, 1), updatedBy: "admin", updatedAt: Date.UTC(2026, 10, 2),
  },
  needsApproval: true, pendingPermissions: ["issues.create"],
  connections: [{ name: "api-key", type: "token", label: "API key", state: "connected", required: true, setBy: "admin", setAt: Date.UTC(2026, 10, 1) }],
};
const removed: PluginView = { ...enabled, id: "legacy", available: false, manifest: null, state: "installed", needsApproval: false, pendingPermissions: [] };
const detail: PluginDetail = {
  ...enabled,
  manifest: manifest("linear", "Linear", {
    category: "issue-tracking", version: "1.2.0",
    contributes: {
      mcpServers: [{ kind: "https", name: "linear", url: "https://mcp.linear.app/mcp", tools: ["search"], capability: "read", authentication: "oauth", connection: "workspace" }],
      skills: ["linear-ticket"], automationTemplates: [], subscriptions: ["task.started"],
      commands: [{ name: "linear", description: "Link a ticket", where: ["issue"], kind: "handler", skills: [], servers: [], needsWrite: false, shared: false, specific: [] }],
      webhooks: [{ name: "events", description: "Linear updates", scheme: "hmac-sha256" }],
    },
  }),
  enableBlockers: ["Set the connection API key"],
  audit: [{ action: "install", actor: "admin", at: Date.UTC(2026, 10, 1), detail: {} }],
};

interface Recorded { method: string; url: string; authorization: string | undefined }
const requests: Recorded[] = [];
let server: Server;
let client: ApiClient;
/** The fake API answers as the plugin routes do: 200 JSON, a 404 `{ error }` for an unknown id, 403 for a non-administrator token. */
function respond(request: IncomingMessage): { status: number; body: unknown } {
  if (request.headers.authorization !== "Bearer admin-token") return { status: 403, body: { error: "Instance settings administration is required" } };
  if (request.url === PLUGIN_API_BASE) return { status: 200, body: { plugins: [available, enabled, removed] } };
  if (request.url === `${PLUGIN_API_BASE}/linear`) return { status: 200, body: { plugin: detail } };
  return { status: 404, body: { error: "Unknown plugin" } };
}

before(async () => {
  server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization });
    const { status, body } = respond(request);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  client = clientWith("admin-token");
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

function clientWith(token: string): ApiClient {
  const { port } = server.address() as AddressInfo;
  return new ApiClient({ getRemoteUrl: () => `http://127.0.0.1:${port}`, getGithubToken: () => token } as unknown as ConfigManager);
}

/** Run a command with console output captured. */
async function capture(run: () => Promise<number>) {
  const log = mock.method(console, "log", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    const code = await run();
    return { code, out: log.mock.calls.map(call => String(call.arguments[0])), err: error.mock.calls.map(call => String(call.arguments[0])) };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

test("the plugin command group has read-only list and show, each with --json", () => {
  const command = createPluginCommand();
  assert.equal(command.name(), "plugin");
  assert.deepEqual(command.commands.map(sub => sub.name()), ["list", "show"]);
  for (const sub of command.commands) assert.deepEqual(sub.options.map(option => option.long), ["--json"]);
  assert.equal(command.commands.find(sub => sub.name() === "show")!.registeredArguments[0].name(), "id");
});

test("the API helpers read the plugin routes with GET only", async () => {
  requests.length = 0;
  assert.deepEqual((await listPlugins({ client })).map(plugin => plugin.id), ["slack", "linear", "legacy"]);
  assert.equal((await getPlugin("linear", { client })).audit.length, 1);
  assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [`GET ${PLUGIN_API_BASE}`, `GET ${PLUGIN_API_BASE}/linear`]);
  assert.ok(requests.every(r => r.authorization === "Bearer admin-token"));
  assert.equal(pluginPath("a/b c"), `${PLUGIN_API_BASE}/a%2Fb%20c`);
});

test("plugin list prints one row per plugin with its state, version and repository limit", async () => {
  const { code, out, err } = await capture(() => runPluginList({}, { client }));
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.match(out[0], /^ID\s+NAME\s+CATEGORY\s+VERSION\s+STATE\s+REPOSITORIES$/);
  assert.match(out[1], /^slack\s+Slack\s+messaging\s+1\.0\.0\s+available\s+-$/);
  assert.match(out[2], /^linear\s+Linear\s+issue-tracking\s+1\.1\.0 → 1\.2\.0\s+enabled \(needs approval\)\s+2$/);
  assert.match(out[3], /^legacy\s+-\s+-\s+1\.1\.0\s+installed \(removed from this ProPR version\)\s+2$/);
  assert.deepEqual(out, formatPluginTable([available, enabled, removed]));
});

test("plugin list --json prints the API's plugins", async () => {
  const { code, out } = await capture(() => runPluginList({ json: true }, { client }));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out[0]), [available, enabled, removed]);
});

test("plugin show prints permissions, connections, contributions and what blocks enabling", async () => {
  const { code, out } = await capture(() => runPluginShow("linear", {}, { client }));
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /^Linear \(linear\)\n {2}Linear for ProPR\./);
  assert.match(text, /State: +enabled \(needs approval\)/);
  assert.match(text, /Installed: +1\.1\.0 by admin on 2026-11-01T00:00:00\.000Z/);
  assert.match(text, /Repositories: acme\/app, acme\/api/);
  assert.match(text, /events\.read: Receive ProPR task/);
  assert.match(text, /Waiting for approval: issues\.create/);
  assert.match(text, /api-key \[token\]: connected, required \(set by admin\)/);
  assert.match(text, /MCP servers: +linear \(https, read\)/);
  assert.match(text, /Commands: +\/linear/);
  assert.match(text, /Webhooks: +events \(hmac-sha256\)/);
  assert.match(text, /Outbound: +hooks\.example\.com/);
  assert.match(text, /Cannot be enabled yet:\n {4}- Set the connection API key/);
  assert.deepEqual(out, formatPluginDetail(detail));
});

test("plugin show --json prints the API's plugin, audit trail included", async () => {
  const { code, out } = await capture(() => runPluginShow("linear", { json: true }, { client }));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out[0]), detail);
});

test("plugin show names an unknown plugin and points at plugin list", async () => {
  const { code, err } = await capture(() => runPluginShow("nope", {}, { client }));
  assert.equal(code, 1);
  assert.deepEqual(err, ["Error: No plugin nope. Run 'propr plugin list' to see the plugins of this ProPR."]);
});

test("a token without plugin administration gets an access message", async () => {
  const { code, err } = await capture(() => runPluginList({}, { client: clientWith("member-token") }));
  assert.equal(code, 1);
  assert.match(err[0], /Access denied\. Plugins need an instance administrator/);
});

test("a plugin no longer in the registry is shown as such", () => {
  assert.equal(pluginStateLabel(removed), "installed (removed from this ProPR version)");
  const text = formatPluginDetail({ ...removed, audit: [] }).join("\n");
  assert.match(text, /no longer part of this ProPR version/);
  assert.doesNotMatch(text, /Contributes:/);
});
