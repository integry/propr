import { z } from 'zod';
import { loadSettings } from '@propr/core';
import type { createConfigRoutes } from '../routes/configRoutes.js';
import { configRevision } from '../routes/configRevision.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import { type McpTool, mutationShape, ok } from './tools.js';

/** The Settings UI stores users and exempt bots together in this list. */
export const BOT_ALLOWLIST_SETTING = 'github_user_whitelist' as const;

const GITHUB_USER_ALLOWLIST_ENV = 'GITHUB_USER_WHITELIST';
const GITHUB_USER_BLOCKLIST_ENV = 'GITHUB_USER_BLACKLIST';
const githubLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/);

type AllowlistSource = 'settings' | 'environment' | 'both';

interface TriggerAccessSnapshot {
  allowlist: string[];
  blocklist: string[];
  source: AllowlistSource;
  environmentAllowlistPresent: boolean;
}

function environmentList(name: string): string[] {
  return (process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean);
}

function normalizeStoredList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean);
}

async function loadTriggerAccessSnapshot(): Promise<TriggerAccessSnapshot> {
  const settings = await loadSettings() as Record<string, unknown>;
  const stored = normalizeStoredList(settings[BOT_ALLOWLIST_SETTING]);
  const environmentAllowlist = environmentList(GITHUB_USER_ALLOWLIST_ENV);
  const environmentAllowlistPresent = environmentAllowlist.length > 0;
  return {
    allowlist: stored ?? environmentAllowlist,
    blocklist: environmentList(GITHUB_USER_BLOCKLIST_ENV),
    source: stored ? (environmentAllowlistPresent ? 'both' : 'settings') : (environmentAllowlistPresent ? 'environment' : 'settings'),
    environmentAllowlistPresent,
  };
}

function isBot(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]');
}

function normalizeBot(login: string): string {
  return isBot(login) ? `${login.slice(0, -5)}[bot]` : `${login}[bot]`;
}

function uniqueLogins(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function response(snapshot: TriggerAccessSnapshot): Record<string, unknown> {
  const editable = snapshot.source !== 'environment';
  return {
    revision: configRevision(snapshot.allowlist),
    users: {
      allowlist: snapshot.allowlist.filter(login => !isBot(login)),
      blocklist: snapshot.blocklist,
      source: { allowlist: snapshot.source, blocklist: 'environment' },
      editable: { allowlist: editable, blocklist: false },
      environment: {
        ...(snapshot.environmentAllowlistPresent ? { allowlist: GITHUB_USER_ALLOWLIST_ENV } : {}),
        blocklist: GITHUB_USER_BLOCKLIST_ENV,
      },
    },
    bots: {
      allowlist: snapshot.allowlist.filter(isBot),
      source: snapshot.source,
      editable,
      ...(snapshot.environmentAllowlistPresent ? { environmentVariable: GITHUB_USER_ALLOWLIST_ENV } : {}),
    },
    notes: [
      `Bots are entries ending in [bot] in ${BOT_ALLOWLIST_SETTING}; the Settings UI displays the same combined list.`,
      'An empty allowlist permits every non-bot GitHub user. Bots still require an explicit [bot]-suffixed entry.',
      `${GITHUB_USER_BLOCKLIST_ENV} is environment-only and cannot be changed through MCP.`,
      ...(snapshot.source === 'both' ? [`Persisted ${BOT_ALLOWLIST_SETTING} takes precedence; ${GITHUB_USER_ALLOWLIST_ENV} is reported for provenance and remains read-only.`] : []),
    ],
  };
}

function applyOperations(current: string[], args: Record<string, unknown>): string[] {
  const removeUsers = (args.removeUsers as string[] | undefined) ?? [];
  const removeBots = ((args.removeBots as string[] | undefined) ?? []).map(normalizeBot);
  const removals = new Set([...removeUsers, ...removeBots].map(value => value.toLowerCase()));
  const retained = current.filter(value => !removals.has(value.toLowerCase()));
  const additions = [
    ...((args.addUsers as string[] | undefined) ?? []),
    ...((args.addBots as string[] | undefined) ?? []).map(normalizeBot),
  ];
  return uniqueLogins([...retained, ...additions]);
}

export function addTriggerAccessTools(tools: McpTool[], config: ReturnType<typeof createConfigRoutes>): void {
  tools.push({
    name: 'get_trigger_access_configuration',
    description: 'Read the effective GitHub trigger user allowlist, environment-only blocklist and explicitly exempt bots.',
    scope: 'manage',
    permission: 'instance.manage_settings',
    readOnly: true,
    schema: z.object({}).strict(),
    run: async () => ok(response(await loadTriggerAccessSnapshot())),
  });

  tools.push({
    name: 'update_trigger_access_configuration',
    description: 'Add or remove GitHub trigger users and exempt bots without replacing the complete allowlist.',
    scope: 'manage',
    permission: 'instance.manage_settings',
    schema: z.object({
      ...mutationShape,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      addUsers: z.array(githubLogin).max(100).optional(),
      removeUsers: z.array(githubLogin).max(100).optional(),
      addBots: z.array(githubLogin).max(100).optional(),
      removeBots: z.array(githubLogin).max(100).optional(),
      confirmOpenAccess: z.boolean().optional(),
    }).strict(),
    run: async ({ principal, args }) => {
      const hasOperation = ['addUsers', 'removeUsers', 'addBots', 'removeBots']
        .some(name => Array.isArray(args[name]) && args[name].length > 0);
      if (!hasOperation) throw new McpError('MISSING_INPUT', 'Provide at least one non-empty add or remove operation.');

      const snapshot = await loadTriggerAccessSnapshot();
      if (snapshot.source === 'environment') {
        throw new McpError(
          'SETTING_ENVIRONMENT_MANAGED',
          `${BOT_ALLOWLIST_SETTING} is controlled by ${GITHUB_USER_ALLOWLIST_ENV}; change that environment variable to edit trigger access.`,
          409,
        );
      }
      if (args.expectedRevision !== configRevision(snapshot.allowlist)) {
        throw new McpError('STALE_REVISION', 'Trigger access configuration changed. Read it again and retry with a new operation key.', 409);
      }

      const updated = applyOperations(snapshot.allowlist, args);
      if (snapshot.allowlist.length > 0 && updated.length === 0 && args.confirmOpenAccess !== true) {
        throw new McpError('CONFIRMATION_REQUIRED', 'Removing the final allowlist entry opens trigger access to every non-bot GitHub user. Set confirmOpenAccess to true to continue.', 409);
      }

      await callWorkflow(config.postSettings, principal, {
        body: {
          settings: { [BOT_ALLOWLIST_SETTING]: updated },
          expectedRevision: args.expectedRevision,
        },
        idempotencyKey: args.idempotencyKey,
      });
      return ok({ ...response({ ...snapshot, allowlist: updated }), updated: true });
    },
  });
}
