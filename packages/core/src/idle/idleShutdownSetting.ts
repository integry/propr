/**
 * The instance setting behind the Web UI idle shutdown control. The
 * environment (`PROPR_IDLE_SHUTDOWN`, `PROPR_IDLE_SHUTDOWN_AFTER`) wins over
 * it field by field; see `resolveIdleShutdownConfig`.
 */

import {
    IDLE_SHUTDOWN_SETTING,
    readStoredIdleShutdownSetting,
    resolveIdleShutdownConfig,
    type IdleShutdownConfig,
    type StoredIdleShutdownSetting,
} from '@propr/shared';
import { getConfigStrict, saveConfig } from '../config/configStore.js';

/** The stored setting, or null when none is stored; throws when it cannot be read or is malformed. */
export async function loadStoredIdleShutdownSetting(): Promise<StoredIdleShutdownSetting | null> {
    return readStoredIdleShutdownSetting(await getConfigStrict<unknown>(IDLE_SHUTDOWN_SETTING, null));
}

export async function saveStoredIdleShutdownSetting(setting: StoredIdleShutdownSetting): Promise<boolean> {
    return saveConfig(IDLE_SHUTDOWN_SETTING, setting);
}

/** The effective setting for this process: environment, then the instance setting, then off. */
export async function loadIdleShutdownConfig(env: NodeJS.ProcessEnv = process.env): Promise<IdleShutdownConfig> {
    return resolveIdleShutdownConfig(env, await loadStoredIdleShutdownSetting());
}
