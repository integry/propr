import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalFleetJson, FLEET_DATA_ACTIONS, FLEET_DATA_ACTOR_CONTRACT, FLEET_DATA_ACTOR_SCHEMA, FLEET_DATA_SCOPE, type FleetActorDataEnvelope as FleetDataEnvelope } from '@propr/shared';
export const contractPin = createHash('sha256').update(FLEET_DATA_ACTOR_SCHEMA).digest('hex');
export const digest = (value: unknown) => createHash('sha256').update(canonicalFleetJson(value)).digest('hex');
export class FleetRefusal extends Error { constructor() { super('Fleet data operation unavailable'); } }
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new FleetRefusal();
}
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function validateAssertion(a: unknown): asserts a is Record<string, unknown> {
  exact(a, ['contract', 'contractPin', 'hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'placementGeneration', 'scope', 'action', 'requestDigest', 'operationId', 'issuedAt', 'expiresAt', 'nonce', 'githubActorId', 'storageGeneration']);
  if (a.contract !== FLEET_DATA_ACTOR_CONTRACT || a.contractPin !== contractPin || a.scope !== FLEET_DATA_SCOPE || !FLEET_DATA_ACTIONS.includes(a.action as never)
    || !identifier(a.hostedInstanceId) || !identifier(a.placementGeneration) || !uuid(a.storageInstanceId) || !uuid(a.runtimeGeneration) || !uuid(a.operationId)
    || !uuid(a.storageGeneration) || !Number.isSafeInteger(a.githubActorId) || Number(a.githubActorId) <= 0
    || !sha256(a.requestDigest) || !sha256(a.nonce)
    || !Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt)) throw new FleetRefusal();
}
export function parseEnvelope(raw: string): FleetDataEnvelope {
  if (Buffer.byteLength(raw) > 8192) throw new FleetRefusal();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new FleetRefusal(); }
  // Requiring the canonical representation also refuses duplicate JSON keys.
  if (canonicalFleetJson(value) !== raw) throw new FleetRefusal();
  exact(value, ['assertion', 'request', 'mac']);
  validateAssertion(value.assertion);
  if (!sha256(value.mac)) throw new FleetRefusal();
  const a = value.assertion;
  const keys = a.action === 'repositories.cleanup.execute' ? ['action', 'previewOperationId', 'confirmation']
    : ['operation.status', 'operation.cancel', 'artifact.stream'].includes(String(a.action)) ? ['action', 'targetOperationId'] : ['action'];
  exact(value.request, keys);
  if (value.request.action !== a.action || keys.slice(1).some(key => !uuid(value.request && (value.request as Record<string, unknown>)[key]))) throw new FleetRefusal();
  if (digest(value.request) !== a.requestDigest) throw new FleetRefusal();
  return value as unknown as FleetDataEnvelope;
}
export function verifyAssertion(envelope: FleetDataEnvelope, secret: string, now = Math.floor(Date.now() / 1000)) {
  const a = envelope.assertion;
  if (secret.length < 32 || secret.trim() !== secret || a.issuedAt > now + 5 || a.issuedAt < now - 65 || a.expiresAt <= now || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > 60) throw new FleetRefusal();
  const expected = createHmac('sha256', secret).update(canonicalFleetJson(a)).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw new FleetRefusal();
}
