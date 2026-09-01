import type { DesktopSetupRequest } from './shared/contract';

const AGENTS = new Set(['claude', 'codex', 'antigravity', 'opencode', 'vibe']);
const CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i;
const INTEGER = /^[1-9][0-9]{0,19}$/;
const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*(?:\.\.|@\{|\\|\s|[~^:?*\[]|\/\/|\.$|\.lock$))[A-Za-z0-9._/-]{1,255}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class SetupRequestError extends Error {
  constructor(message = 'Invalid local setup request') {
    super(message);
    this.name = 'SetupRequestError';
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupRequestError();
  return value as Record<string, unknown>;
};

const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.has(key))) throw new SetupRequestError();
};

const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export const parseDesktopSetupRequest = (input: unknown): DesktopSetupRequest => {
  const value = record(input);
  exact(value, ['sessionId', 'root', 'reinitialize', 'agents', 'github', 'intake', 'whitelist', 'repository']);
  if (typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId)) throw new SetupRequestError();
  if (typeof value.reinitialize !== 'boolean') throw new SetupRequestError();

  const root = record(value.root);
  if (root.mode === 'default' || root.mode === 'resume') exact(root, ['mode']);
  else throw new SetupRequestError();

  const agents = value.agents;
  if (!Array.isArray(agents) || agents.length > AGENTS.size || !agents.every(item => typeof item === 'string' && AGENTS.has(item)) || new Set(agents).size !== agents.length) {
    throw new SetupRequestError('Invalid agent selection');
  }

  const github = record(value.github);
  switch (github.mode) {
    case 'keep': case 'demo': case 'relay': exact(github, ['mode']); break;
    case 'app':
      exact(github, ['mode', 'appId', 'privateKeyCapability', 'installationId']);
      if (!bounded(github.appId, 20) || !INTEGER.test(github.appId) || !bounded(github.installationId, 20) || !INTEGER.test(github.installationId)
        || typeof github.privateKeyCapability !== 'string' || !CAPABILITY.test(github.privateKeyCapability)) throw new SetupRequestError('Invalid GitHub App configuration');
      break;
    default: throw new SetupRequestError('Invalid GitHub configuration');
  }

  const intake = record(value.intake);
  if (intake.mode === 'keep' || intake.mode === 'routing_websocket' || intake.mode === 'polling') exact(intake, ['mode']);
  else if (intake.mode === 'direct_webhook') {
    exact(intake, ['mode', 'secretCapability']);
    if (typeof intake.secretCapability !== 'string' || !CAPABILITY.test(intake.secretCapability)) throw new SetupRequestError('Invalid webhook secret capability');
  } else throw new SetupRequestError('Invalid GitHub intake configuration');
  if ((github.mode === 'relay' && intake.mode === 'direct_webhook')
    || (github.mode === 'app' && intake.mode === 'routing_websocket')
    || (github.mode === 'demo' && intake.mode !== 'keep')) throw new SetupRequestError('GitHub intake mode is incompatible with the selected authentication mode');

  if (value.whitelist !== null && (!Array.isArray(value.whitelist) || value.whitelist.length > 100
    || !value.whitelist.every(item => typeof item === 'string' && USERNAME.test(item)) || new Set(value.whitelist.map(item => item.toLowerCase())).size !== value.whitelist.length)) {
    throw new SetupRequestError('Invalid GitHub whitelist');
  }

  if (value.repository !== null) {
    const repository = record(value.repository);
    exact(repository, ['fullName'], ['alias', 'baseBranch']);
    const [owner, name, extra] = typeof repository.fullName === 'string' ? repository.fullName.split('/') : [];
    if (!bounded(repository.fullName, 140) || extra !== undefined || !owner || !USERNAME.test(owner) || !name || !REPOSITORY_NAME.test(name) || name === '.' || name === '..'
      || (repository.alias !== undefined && (typeof repository.alias !== 'string' || !ALIAS.test(repository.alias)))
      || (repository.baseBranch !== undefined && (typeof repository.baseBranch !== 'string' || !BRANCH.test(repository.baseBranch)))) {
      throw new SetupRequestError('Invalid repository selection');
    }
  }
  return structuredClone(value) as unknown as DesktopSetupRequest;
};
