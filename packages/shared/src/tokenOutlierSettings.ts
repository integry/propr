/**
 * Instance settings for the token-outlier alert: a recorded execution whose
 * total tokens exceed `token_outlier_multiplier` times the median of the last
 * `token_outlier_baseline_runs` successful executions for the same
 * repository, model and execution type, and also exceed
 * `token_outlier_min_tokens`, raises a `warning` Inbox notification on its
 * task. With `token_outlier_pause_alerts` above 0, that many alerts for one
 * repository within `token_outlier_pause_window_hours` pause its scheduled
 * automations until the window has passed.
 */
export interface TokenOutlierSettingDefinition {
    defaultValue: number;
    min: number;
    max: number;
    integer: boolean;
    description: string;
}

/** No alert fires before a baseline has at least this many successful executions. */
export const TOKEN_OUTLIER_MIN_HISTORY = 8;

export const TOKEN_OUTLIER_SETTING_DEFINITIONS = {
    token_outlier_multiplier: {
        defaultValue: 4, min: 1.5, max: 100, integer: false,
        description: 'Alert when a run uses more than this multiple of its baseline (median) tokens',
    },
    token_outlier_min_tokens: {
        defaultValue: 500_000, min: 1_000, max: 1_000_000_000_000, integer: true,
        description: 'Absolute token floor: runs at or below it never alert',
    },
    token_outlier_baseline_runs: {
        defaultValue: 20, min: TOKEN_OUTLIER_MIN_HISTORY, max: 200, integer: true,
        description: `Successful executions in the baseline median (repository, model and execution type; at least ${TOKEN_OUTLIER_MIN_HISTORY} before any alert)`,
    },
    token_outlier_pause_alerts: {
        defaultValue: 0, min: 0, max: 1_000, integer: true,
        description: 'Pause a repository\'s scheduled automations after this many token alerts within the window (0 = off)',
    },
    token_outlier_pause_window_hours: {
        defaultValue: 24, min: 1, max: 720, integer: true,
        description: 'Window, in hours, over which token alerts are counted for the automation pause',
    },
} as const satisfies Record<string, TokenOutlierSettingDefinition>;

export type TokenOutlierSettingName = keyof typeof TOKEN_OUTLIER_SETTING_DEFINITIONS;
export const TOKEN_OUTLIER_SETTING_NAMES = Object.keys(TOKEN_OUTLIER_SETTING_DEFINITIONS) as TokenOutlierSettingName[];
export type TokenOutlierSettings = Record<TokenOutlierSettingName, number>;

export const DEFAULT_TOKEN_OUTLIER_SETTINGS: TokenOutlierSettings = Object.fromEntries(
    TOKEN_OUTLIER_SETTING_NAMES.map(name => [name, TOKEN_OUTLIER_SETTING_DEFINITIONS[name].defaultValue]),
) as TokenOutlierSettings;

export function isTokenOutlierSettingName(name: string): name is TokenOutlierSettingName {
    return Object.hasOwn(TOKEN_OUTLIER_SETTING_DEFINITIONS, name);
}

/** The accepted range of a setting, in words, for validation errors. */
export function describeTokenOutlierSettingRange(name: TokenOutlierSettingName): string {
    const { min, max, integer } = TOKEN_OUTLIER_SETTING_DEFINITIONS[name];
    return `${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`;
}

/**
 * The validated value of one setting, or null when it is out of range or not
 * a number. Numeric strings are accepted (the CLI and form inputs send them).
 */
export function parseTokenOutlierSetting(name: TokenOutlierSettingName, raw: unknown): number | null {
    const { min, max, integer } = TOKEN_OUTLIER_SETTING_DEFINITIONS[name];
    const value = typeof raw === 'number' ? raw
        : typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value < min || value > max) return null;
    if (integer && !Number.isSafeInteger(value)) return null;
    return value;
}
