import { pluginSettingProblem, type PluginSetting, type PluginSettings, type PluginSettingValue } from '@propr/shared';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';

/** The settings schema of a manifest, in the JSON Schema subset ProPR accepts. */
export const settingsOf = (manifest: PluginManifestView) => manifest.settings as unknown as PluginSettings;

export interface RepositoryMapRow { repository: string; text: string }
/**
 * A list or repository map while it is edited: its entries exactly as they will be saved, and whether the setting has a
 * value at all. A saved empty collection (`set` with no rows) is a value; a removed setting (`set: false`) is not.
 */
export interface CollectionDraft<Row> { set: boolean; rows: Row[] }
/** What a field holds while it is edited: text for text and number fields, a tick for a checkbox, entries for a list or repository map. */
export type SettingDraft = string | boolean | CollectionDraft<string> | CollectionDraft<RepositoryMapRow>;
export type SettingDrafts = Record<string, SettingDraft>;

const filledRows = (rows: RepositoryMapRow[]) => rows.map(row => ({ repository: row.repository.trim(), text: row.text })).filter(row => row.repository || row.text);
const hasValue = (values: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(values, key);

/** The field state of one saved value; an unset setting starts empty (or unticked). List entries are kept exactly. */
export function draftOf(setting: PluginSetting, value: PluginSettingValue | undefined): SettingDraft {
  switch (setting.type) {
    case 'string': return typeof value === 'string' ? value : '';
    case 'number': return typeof value === 'number' ? String(value) : '';
    case 'boolean': return value === true;
    case 'array': return Array.isArray(value) ? { set: true, rows: value.map(String) } : { set: false, rows: [] };
    case 'object': return value && typeof value === 'object' && !Array.isArray(value)
      ? { set: true, rows: Object.entries(value).map(([repository, text]) => ({ repository, text: String(text) })) }
      : { set: false, rows: [] };
  }
}

/**
 * The value a field saves: `null` removes the setting (an empty text or number, or a cleared list or map). A list saves
 * its entries as typed, and an empty list or map that is still set saves as empty. A number that does not parse stays a
 * string so validation names the problem instead of dropping it.
 */
export function valueOf(setting: PluginSetting, draft: SettingDraft): unknown {
  switch (setting.type) {
    case 'string': return draft === '' ? null : draft;
    case 'number': { const text = String(draft).trim(); return text === '' ? null : (Number.isFinite(Number(text)) ? Number(text) : text); }
    case 'boolean': return draft === true;
    case 'array': { const list = draft as CollectionDraft<string>; return list.set || list.rows.length ? [...list.rows] : null; }
    case 'object': {
      const map = draft as CollectionDraft<RepositoryMapRow>;
      const rows = filledRows(map.rows);
      return map.set || rows.length ? Object.fromEntries(rows.map(row => [row.repository, row.text])) : null;
    }
  }
}

export const draftsOf = (settings: PluginSettings, values: Record<string, PluginSettingValue>): SettingDrafts =>
  Object.fromEntries(Object.entries(settings.properties).map(([key, setting]) => [key, draftOf(setting, hasValue(values, key) ? values[key] : undefined)]));

/**
 * The value one setting saves. A field left as it started saves exactly the saved value (or keeps an unset setting
 * unset), so saving another setting never rewrites it; an edited field saves what it now holds.
 */
function fieldValue(settings: PluginSettings, key: string, drafts: SettingDrafts, saved: Record<string, PluginSettingValue>): unknown {
  const setting = settings.properties[key];
  const savedValue = hasValue(saved, key) ? saved[key] : undefined;
  if (JSON.stringify(drafts[key]) === JSON.stringify(draftOf(setting, savedValue))) return savedValue ?? null;
  return valueOf(setting, drafts[key]);
}

/** The complete settings object a save sends: every setting, `null` for those removed or never set. */
export const settingsPayload = (settings: PluginSettings, drafts: SettingDrafts, saved: Record<string, PluginSettingValue> = {}) =>
  Object.fromEntries(Object.keys(settings.properties).map(key => [key, fieldValue(settings, key, drafts, saved)])) as Record<string, PluginSettingValue | null>;

/**
 * Problems found before saving, by setting key, with the same wording as the API. A required setting may be empty while
 * the plugin is disabled (it only blocks enabling); while enabled it cannot be removed.
 */
export function clientSettingErrors(settings: PluginSettings, drafts: SettingDrafts, enabled: boolean, saved: Record<string, PluginSettingValue> = {}): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, setting] of Object.entries(settings.properties)) {
    if (setting.type === 'object') {
      const repeated = filledRows((drafts[key] as CollectionDraft<RepositoryMapRow>).rows).map(row => row.repository).find((name, index, all) => all.indexOf(name) !== index);
      if (repeated) { errors[key] = `${key} lists ${repeated} more than once`; continue; }
    }
    const value = fieldValue(settings, key, drafts, saved);
    if (value === null || value === '') {
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
