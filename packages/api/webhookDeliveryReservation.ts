const FAILED_CANCELLATION_RETRY_TTL_SECONDS = 30;
const RETRYABLE_RESERVATION_PREFIX = 'retry-open:';

export interface WebhookDeliveryReservationRedis {
  set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  eval?: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>;
}

interface DeliveryReservationRetryReleaseResult {
  released: boolean;
  retryReservationOpened: boolean;
}

interface DeliveryReservationPayload {
  repository?: { full_name?: string };
  pull_request?: { number?: number };
}

interface DeliveryReservationLog {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export async function releaseDeliveryReservationForRetry(params: {
  redis: WebhookDeliveryReservationRedis;
  deliveryKey: string;
  reservationToken: string;
  payload: DeliveryReservationPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  log: DeliveryReservationLog;
  failureContext: string;
}): Promise<DeliveryReservationRetryReleaseResult> {
  const {
    redis,
    deliveryKey,
    reservationToken,
    payload,
    rawDeliveryId,
    rawEvent,
    correlationId,
    log,
    failureContext,
  } = params;

  try {
    const deletedKeys = await compareAndDeleteDeliveryReservation(redis, deliveryKey, reservationToken);
    if (deletedKeys > 0) {
      return { released: true, retryReservationOpened: false };
    }

    const retryReservationOpened = await openDeliveryReservationForRetry({
      redis,
      deliveryKey,
      reservationToken,
      payload,
      rawDeliveryId,
      rawEvent,
      correlationId,
      log,
      failureContext,
    });
    return { released: false, retryReservationOpened };
  } catch (releaseError) {
    const retryReservationOpened = await openDeliveryReservationForRetry({
      redis,
      deliveryKey,
      reservationToken,
      payload,
      rawDeliveryId,
      rawEvent,
      correlationId,
      log,
      failureContext,
    });
    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (releaseError as Error).message,
      deliveryReservationRetryOpened: retryReservationOpened,
    }, `Failed to release webhook delivery reservation after ${failureContext}`);
    return { released: false, retryReservationOpened };
  }
}

export async function reserveRetryableDeliveryReservation(params: {
  redis: WebhookDeliveryReservationRedis;
  deliveryKey: string;
  reservationToken: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const {
    redis,
    deliveryKey,
    reservationToken,
    ttlSeconds,
  } = params;
  return compareAndReserveRetryableDeliveryReservation(redis, deliveryKey, reservationToken, ttlSeconds);
}

async function openDeliveryReservationForRetry(params: {
  redis: WebhookDeliveryReservationRedis;
  deliveryKey: string;
  reservationToken: string;
  payload: DeliveryReservationPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  log: DeliveryReservationLog;
  failureContext: string;
}): Promise<boolean> {
  const { redis, deliveryKey, reservationToken, payload, rawDeliveryId, rawEvent, correlationId, log, failureContext } = params;
  try {
    return await compareAndOpenDeliveryReservationForRetry(redis, deliveryKey, reservationToken);
  } catch (ttlUpdateError) {
    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (ttlUpdateError as Error).message,
    }, `Failed to open webhook delivery reservation for retry after ${failureContext}`);
    return false;
  }
}

async function compareAndDeleteDeliveryReservation(
  redis: WebhookDeliveryReservationRedis,
  deliveryKey: string,
  reservationToken: string,
): Promise<number> {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      { keys: [deliveryKey], arguments: [reservationToken] },
    );
    return Number(result);
  }

  // Best-effort fallback for tests or minimal Redis adapters. Production
  // clients should provide eval so the token comparison and mutation are atomic.
  return (await redis.get(deliveryKey)) === reservationToken
    ? redis.del(deliveryKey)
    : 0;
}

async function compareAndOpenDeliveryReservationForRetry(
  redis: WebhookDeliveryReservationRedis,
  deliveryKey: string,
  reservationToken: string,
): Promise<boolean> {
  const retryableValue = getRetryableReservationValue(reservationToken);
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 else return 0 end',
      { keys: [deliveryKey], arguments: [reservationToken, retryableValue, String(FAILED_CANCELLATION_RETRY_TTL_SECONDS)] },
    );
    return Number(result) === 1;
  }

  // Best-effort fallback for tests or minimal Redis adapters. Production
  // clients should provide eval so the token comparison and TTL update are atomic.
  if (await redis.get(deliveryKey) !== reservationToken) {
    return false;
  }

  await redis.set(deliveryKey, retryableValue, { EX: FAILED_CANCELLATION_RETRY_TTL_SECONDS });
  return true;
}

async function compareAndReserveRetryableDeliveryReservation(
  redis: WebhookDeliveryReservationRedis,
  deliveryKey: string,
  reservationToken: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(
      'local value = redis.call("GET", KEYS[1]); if value and string.sub(value, 1, string.len(ARGV[1])) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 else return 0 end',
      { keys: [deliveryKey], arguments: [RETRYABLE_RESERVATION_PREFIX, reservationToken, String(ttlSeconds)] },
    );
    return Number(result) === 1;
  }

  const existingReservation = await redis.get(deliveryKey);
  if (!isRetryableReservationValue(existingReservation)) {
    return false;
  }

  await redis.set(deliveryKey, reservationToken, { EX: ttlSeconds });
  return true;
}

function getRetryableReservationValue(reservationToken: string): string {
  return `${RETRYABLE_RESERVATION_PREFIX}${reservationToken}`;
}

function isRetryableReservationValue(value: string | null): boolean {
  return value !== null && value.startsWith(RETRYABLE_RESERVATION_PREFIX);
}
