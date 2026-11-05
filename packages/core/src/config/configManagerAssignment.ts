import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { parseBooleanSetting } from './mergeConflictSettingsResolution.js';

// --- Follow-up Requires Assignment ---

/** Instance-wide switch stored as its own `system_configs` row. */
export const FOLLOWUP_REQUIRES_ASSIGNMENT_CONFIG_KEY = 'followup_requires_assignment';

/**
 * Loads whether only users assigned to a task may start follow-up work on it.
 * Returns false when the setting is absent or not a boolean.
 */
export async function loadFollowupRequiresAssignment(): Promise<boolean> {
    const raw = await getConfig<unknown>(FOLLOWUP_REQUIRES_ASSIGNMENT_CONFIG_KEY, false);
    const parsed = parseBooleanSetting(raw);
    if (parsed === null && raw !== null && raw !== undefined) {
        logger.warn({ key: FOLLOWUP_REQUIRES_ASSIGNMENT_CONFIG_KEY, valueType: typeof raw }, 'Stored follow-up requires assignment setting is not a boolean; treating it as disabled');
    }
    return parsed ?? false;
}

export async function saveFollowupRequiresAssignment(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== 'boolean') {
        throw new Error('followup_requires_assignment must be a boolean');
    }
    await saveConfig(FOLLOWUP_REQUIRES_ASSIGNMENT_CONFIG_KEY, enabled);
    logger.info({ followup_requires_assignment: enabled }, 'Successfully saved follow-up requires assignment setting');
    return true;
}
