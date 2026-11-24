/**
 * The instance setting behind the Web UI idle shutdown control. The
 * environment (`PROPR_IDLE_SHUTDOWN`, `PROPR_IDLE_SHUTDOWN_AFTER`) wins over
 * it field by field; see `resolveIdleShutdownConfig`.
 */

import {
    IDLE_SHUTDOWN_SETTING,
    parseStoredIdleShutdownSetting,
    resolveIdleShutdownConfig,
    type IdleShutdownConfig,
    type StoredIdleShutdownSetting,
} from '@propr/shared';
import { getConfigStrict, saveConfig } from '../config/configStore.js';

export async function loadStoredIdleShutdownSetting(): Promise<StoredIdleShutdownSetting | null> {
    return parseStoredIdleShutdownSetting(await getConfigStrict<unknown>(IDLE_SHUTDOWN_SETTING, null));
}

export async function saveStoredIdleShutdownSetting(setting: StoredIdleShutdownSetting): Promise<boolean> {
    return saveConfig(IDLE_SHUTDOWN_SETTING, setting);
}

/** The effective setting for this process: environment, then the instance setting, then off. */
export async function loadIdleShutdownConfig(env: NodeJS.ProcessEnv = process.env): Promise<IdleShutdownConfig> {
    return resolveIdleShutdownConfig(env, await loadStoredIdleShutdownSetting());
}
