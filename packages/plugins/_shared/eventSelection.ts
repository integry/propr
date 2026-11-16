import { isPluginSubscriptionEvent, type PluginSettingValues, type RepositoryEvent } from '@propr/shared';

/**
 * Event selection shared by official plugins that forward ProPR events to a
 * service (outbound webhooks, chat plugins): which events a destination wants
 * and for which repositories. It uses SDK types only, so it runs wherever the
 * handlers do.
 *
 * A destination's selection comes from two list settings: the event names
 * (`<domain>.<type>`, such as `pull_request.merged`) and an optional
 * repository filter (`owner/repo`, compared without letter case; an empty or
 * unset list means every repository the plugin is enabled for).
 */

/** `<domain>.<type>` of a journal event, as subscriptions and selections name it. */
export const eventName = (event: Pick<RepositoryEvent, 'domain' | 'type'>): string => `${event.domain}.${event.type}`;

/** What one destination receives. */
export interface EventSelection {
  /** Event names; only events named here are sent. */
  events: readonly string[];
  /** `owner/repo` names; empty for every repository. */
  repositories: readonly string[];
}

const textList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * The selection stored in two list settings. Unknown event names and blank
 * repository entries are dropped; repositories are trimmed.
 */
export function readEventSelection(settings: PluginSettingValues, eventsKey: string, repositoriesKey: string): EventSelection {
  const events = [...new Set(textList(settings[eventsKey]).filter(isPluginSubscriptionEvent))];
  const repositories = [...new Set(textList(settings[repositoriesKey]).map(name => name.trim()).filter(Boolean))];
  return { events, repositories };
}

/** Whether the repository filter takes `repository` (an empty filter takes every repository). */
export function repositorySelected(repositories: readonly string[], repository: string): boolean {
  if (!repositories.length) return true;
  const name = repository.toLowerCase();
  return repositories.some(entry => entry.toLowerCase() === name);
}

/** Whether a destination with this selection receives `event`. */
export function eventSelected(selection: EventSelection, event: Pick<RepositoryEvent, 'domain' | 'type' | 'repository'>): boolean {
  return selection.events.includes(eventName(event)) && repositorySelected(selection.repositories, event.repository);
}

/** The destinations, in order, whose selection takes `event`. */
export function matchingDestinations<T extends EventSelection>(destinations: readonly T[], event: Pick<RepositoryEvent, 'domain' | 'type' | 'repository'>): T[] {
  return destinations.filter(destination => eventSelected(destination, event));
}
