const FAILED_CANCELLATION_RETRY_TTL_SECONDS = 30;

export interface WebhookDeliveryReservationRedis {
  set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  eval?: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>;
}

interface DeliveryReservationRetryReleaseResult {
  released: boolean;
  retryTtlShortened: boolean;
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
      return { released: true, retryTtlShortened: false };
    }

    const retryTtlShortened = await shortenDeliveryReservationRetryTtl({
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
    return { released: false, retryTtlShortened };
  } catch (releaseError) {
    const retryTtlShortened = await shortenDeliveryReservationRetryTtl({
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
      deliveryReservationRetryTtlShortened: retryTtlShortened,
    }, `Failed to release webhook delivery reservation after ${failureContext}`);
    return { released: false, retryTtlShortened };
  }
}

async function shortenDeliveryReservationRetryTtl(params: {
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
    return await compareAndShortenDeliveryReservationTtl(redis, deliveryKey, reservationToken);
  } catch (ttlUpdateError) {
    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (ttlUpdateError as Error).message,
    }, `Failed to shorten webhook delivery reservation TTL after ${failureContext}`);
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

  return (await redis.get(deliveryKey)) === reservationToken
    ? redis.del(deliveryKey)
    : 0;
}

async function compareAndShortenDeliveryReservationTtl(
  redis: WebhookDeliveryReservationRedis,
  deliveryKey: string,
  reservationToken: string,
): Promise<boolean> {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]); return 1 else return 0 end',
      { keys: [deliveryKey], arguments: [reservationToken, String(FAILED_CANCELLATION_RETRY_TTL_SECONDS)] },
    );
    return Number(result) === 1;
  }

  if (await redis.get(deliveryKey) !== reservationToken) {
    return false;
  }

  await redis.set(deliveryKey, reservationToken, { EX: FAILED_CANCELLATION_RETRY_TTL_SECONDS });
  return true;
}
