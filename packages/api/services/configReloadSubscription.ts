export const CONFIG_EVENT_CHANNEL = 'system:config:events';

interface RedisSubscriber {
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface DuplicableRedisClient {
  duplicate(): RedisSubscriber;
}

interface SubscriptionLogger {
  error(message: string, error: unknown): void;
}

export interface ConfigReloadSubscription {
  reload(): Promise<void>;
  close(): Promise<void>;
}

function isSettingsUpdate(message: string): boolean {
  const event = JSON.parse(message) as { type?: unknown; subtype?: unknown };
  return event.type === 'config_update' && event.subtype === 'settings_update';
}

/**
 * Keep API authorization settings synchronized with changes made through the
 * settings routes. Reloads are serialized so a slower earlier read cannot
 * overwrite the result of a later notification.
 */
export async function startConfigReloadSubscription(
  redisClient: DuplicableRedisClient,
  reloadSettings: () => Promise<void>,
  logger: SubscriptionLogger = console,
): Promise<ConfigReloadSubscription> {
  const subscriber = redisClient.duplicate();
  let closed = false;
  let reloadQueue = Promise.resolve();
  const enqueueReload = (): Promise<void> => {
    reloadQueue = reloadQueue
      .then(reloadSettings)
      .catch(error => logger.error('Failed to reload API settings:', error));
    return reloadQueue;
  };

  subscriber.on('error', error => {
    logger.error('API config reload subscriber error:', error);
  });
  try {
    await subscriber.connect();
    await subscriber.subscribe(CONFIG_EVENT_CHANNEL, message => {
      if (closed) return;
      try {
        if (!isSettingsUpdate(message)) return;
      } catch (error) {
        logger.error('Failed to parse API config update event:', error);
        return;
      }
      void enqueueReload();
    });
  } catch (error) {
    await subscriber.quit().catch(() => undefined);
    throw error;
  }

  return {
    reload: enqueueReload,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await subscriber.unsubscribe(CONFIG_EVENT_CHANNEL);
        await reloadQueue;
      } finally {
        await subscriber.quit();
      }
    },
  };
}
