import logger from '../utils/logger.js';
import { getConfig } from './configStore.js';
import {
    TOKEN_OUTLIER_SETTING_DEFINITIONS, TOKEN_OUTLIER_SETTING_NAMES, parseTokenOutlierSetting, type TokenOutlierSettings,
} from '@propr/shared';

export {
    TOKEN_OUTLIER_MIN_HISTORY, TOKEN_OUTLIER_SETTING_DEFINITIONS, TOKEN_OUTLIER_SETTING_NAMES, DEFAULT_TOKEN_OUTLIER_SETTINGS,
    isTokenOutlierSettingName, describeTokenOutlierSettingRange, parseTokenOutlierSetting,
    type TokenOutlierSettingDefinition, type TokenOutlierSettingName, type TokenOutlierSettings,
} from '@propr/shared';

/**
 * All token-outlier settings in force. A missing, malformed or unreadable
 * stored value uses its default.
 */
export async function loadTokenOutlierSettings(
    { readConfig = getConfig }: { readConfig?: <T>(key: string, fallback: T) => Promise<T> } = {},
): Promise<TokenOutlierSettings> {
    const entries = await Promise.all(TOKEN_OUTLIER_SETTING_NAMES.map(async name => {
        const fallback = TOKEN_OUTLIER_SETTING_DEFINITIONS[name].defaultValue;
        try {
            const stored = await readConfig<unknown>(name, fallback);
            if (stored === null || stored === undefined) return [name, fallback] as const;
            const value = parseTokenOutlierSetting(name, stored);
            if (value !== null) return [name, value] as const;
            logger.warn({ stored_value: stored }, `Invalid ${name} in DB, using default`);
        } catch (error) {
            logger.warn({ err: error }, `Could not load ${name}, using default`);
        }
        return [name, fallback] as const;
    }));
    return Object.fromEntries(entries) as TokenOutlierSettings;
}
