import { pluginSettingProblem, type PluginSetting, type PluginSettings, type PluginSettingValue } from '@propr/shared';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';

/** The settings schema of a manifest, in the JSON Schema subset ProPR accepts. */
export const settingsOf = (manifest: PluginManifestView) => manifest.settings as unknown as PluginSettings;

export interface RepositoryMapRow { repository: string; text: string }
/** What a field holds while it is edited: text for text, number and list fields, a tick for a checkbox, rows for a repository map. */
export type SettingDraft = string | boolean | RepositoryMapRow[];
export type SettingDrafts = Record<string, SettingDraft>;

const listLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const filledRows = (rows: RepositoryMapRow[]) => rows.map(row => ({ repository: row.repository.trim(), text: row.text })).filter(row => row.repository || row.text);

/** The field state of one saved value; an unset setting starts empty (or unticked). */
export function draftOf(setting: PluginSetting, value: PluginSettingValue | undefined): SettingDraft {
  switch (setting.type) {
    case 'string': return typeof value === 'string' ? value : '';
    case 'number': return typeof value === 'number' ? String(value) : '';
    case 'boolean': return value === true;
    case 'array': return Array.isArray(value) ? value.join('\n') : '';
    case 'object': return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([repository, text]) => ({ repository, text })) : [];
  }
}

/**
 * The value a field saves: `null` removes the setting (an empty text, number, list or map). A number that does not parse
 * stays a string so validation names the problem instead of dropping it.
 */
export function valueOf(setting: PluginSetting, draft: SettingDraft): unknown {
  switch (setting.type) {
    case 'string': return draft === '' ? null : draft;
    case 'number': { const text = String(draft).trim(); return text === '' ? null : (Number.isFinite(Number(text)) ? Number(text) : text); }
    case 'boolean': return draft === true;
    case 'array': { const items = listLines(String(draft)); return items.length ? items : null; }
    case 'object': {
      const rows = filledRows(draft as RepositoryMapRow[]);
      return rows.length ? Object.fromEntries(rows.map(row => [row.repository, row.text])) : null;
    }
  }
}

export const draftsOf = (settings: PluginSettings, values: Record<string, PluginSettingValue>): SettingDrafts =>
  Object.fromEntries(Object.entries(settings.properties).map(([key, setting]) => [key, draftOf(setting, Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined)]));

/** The complete settings object a save sends: every setting, `null` for those removed. */
export const settingsPayload = (settings: PluginSettings, drafts: SettingDrafts) =>
  Object.fromEntries(Object.keys(settings.properties).map(key => [key, valueOf(settings.properties[key], drafts[key])])) as Record<string, PluginSettingValue | null>;

/**
 * Problems found before saving, by setting key, with the same wording as the API. A required setting may be empty while
 * the plugin is disabled (it only blocks enabling); while enabled it cannot be removed.
 */
export function clientSettingErrors(settings: PluginSettings, drafts: SettingDrafts, enabled: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, setting] of Object.entries(settings.properties)) {
    if (setting.type === 'object') {
      const repeated = filledRows(drafts[key] as RepositoryMapRow[]).map(row => row.repository).find((name, index, all) => all.indexOf(name) !== index);
      if (repeated) { errors[key] = `${key} lists ${repeated} more than once`; continue; }
    }
    const value = valueOf(setting, drafts[key]);
    if (value === null) {
      if (enabled && settings.required.includes(key)) errors[key] = `${key} is required while the plugin is enabled`;
      continue;
    }
    const problem = pluginSettingProblem(key, setting, value);
    if (problem) errors[key] = problem;
  }
  return errors;
}

/**
 * Split an API refusal into field errors and the rest. The API joins setting problems with "; ", each starting with the
 * setting key (keys are letters, digits and _); a refusal to remove required settings names them after a colon.
 */
export function apiSettingErrors(settings: PluginSettings, message: string): { fields: Record<string, string>; other: string[] } {
  const fields: Record<string, string> = {};
  const other: string[] = [];
  const isKey = (key: string) => Object.prototype.hasOwnProperty.call(settings.properties, key);
  for (const part of message.split('; ').map(text => text.trim()).filter(Boolean)) {
    const required = /^Required settings cannot be removed while the plugin is enabled: (.+)$/.exec(part);
    const named = required ? required[1].split(',').map(key => key.trim()).filter(isKey) : [];
    if (named.length) { for (const key of named) fields[key] = `${key} is required while the plugin is enabled`; continue; }
    const key = /^([A-Za-z][A-Za-z0-9_]*) /.exec(part)?.[1];
    if (key && isKey(key)) fields[key] = fields[key] ? `${fields[key]}; ${part}` : part;
    else other.push(part);
  }
  return { fields, other };
}

/** Labels of the required settings that have no saved value. */
export function missingRequiredSettings(view: PluginView): string[] {
  if (!view.manifest || !view.installation) return [];
  const settings = settingsOf(view.manifest);
  const values = view.installation.settings as Record<string, unknown>;
  return settings.required.filter(key => !Object.prototype.hasOwnProperty.call(values, key) || values[key] === '' || values[key] === null)
    .map(key => settings.properties[key]?.label ?? key);
}
