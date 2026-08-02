import { garbageCollectPushSubscriptions } from '@propr/core';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

async function runPushSubscriptionMaintenance(): Promise<void> {
  try {
    const deleted = await garbageCollectPushSubscriptions();
    if (deleted > 0) {
      console.log(`Garbage-collected ${deleted} push subscription record(s)`);
    }
  } catch (error) {
    console.warn('Could not maintain push subscriptions:', (error as Error).message);
  }
}

export async function initializePushSubscriptionMaintenance(): Promise<void> {
  await runPushSubscriptionMaintenance();
  setInterval(runPushSubscriptionMaintenance, MAINTENANCE_INTERVAL_MS);
}
