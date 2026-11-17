import { PLUGIN_PROPR_LIMITS, PluginDeliveryError, PluginSdkError, type PluginContext, type PluginJsonValue, type PluginSettingValues } from '@propr/shared';
import { deleteTicket, reserveTicket, writeTicket } from './trackerRecords.js';

/**
 * Handing an issue tracker ticket to ProPR: one GitHub issue in the mapped
 * repository, with the ticket's title and description, a link back to the
 * ticket and the ProPR trigger label, so the ordinary label-triggered intake
 * starts the task. Shared by the Linear and Jira plugins.
 *
 * Ticket text is untrusted. It becomes the issue's title and body and nothing
 * else: the repository comes from the plugin's mapping, the label from its
 * settings, and the model from ProPR's own routing. In the body it is quoted,
 * with `&`, `<` and `>` written as entities (so no HTML and no hidden
 * `<!-- … -->` marker ProPR reads) and `@` mentions made inert.
 */

export const DEFAULT_GITHUB_LABEL = 'AI';
export const TICKET_TEXT_LIMITS = { descriptionChars: 20_000, titleChars: 200 } as const;
/**
 * The issue body, wrapper and escaped description together, in UTF-8 bytes:
 * `ctx.propr.createIssue` takes at most `bodyChars` characters (a UTF-8 byte
 * count bounds them) and then appends ProPR's attribution marker, for which
 * this leaves room.
 */
export const ISSUE_BODY_BYTES = PLUGIN_PROPR_LIMITS.bodyChars - 1024;
const ELLIPSIS = '…';
const utf8 = (text: string) => Buffer.byteLength(text);
/** Pieces a cut never splits: an entity, a mention and its word joiner, a whole code point. */
const UNSPLITTABLE = /&(?:amp|lt|gt);|@\u2060|[\s\S]/gu;
/** A label ProPR could use as a trigger: no commas, no control characters, at most 50 characters. */
const LABEL = /^[^\s,\x00-\x1f\x7f][^,\x00-\x1f\x7f]{0,49}$/;
/** Control characters and bidirectional overrides, dropped from ticket text. */
const UNSAFE_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g;

/** The GitHub label setting, checked: an invalid one fails the delivery rather than create an issue nothing picks up. */
export function githubTriggerLabel(settings: PluginSettingValues, key: string): string {
  const value = settings[key];
  const label = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_GITHUB_LABEL;
  if (!LABEL.test(label)) throw new PluginDeliveryError('The GitHub trigger label setting is not a usable label (no commas, at most 50 characters). Fix the plugin\'s settings', { permanent: true });
  return label;
}

const plain = (text: string) => text.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARACTERS, '');

/** The issue title: the reference and the ticket's first non-empty title line, whitespace collapsed, without `<` and `>`, capped. */
export function ticketIssueTitle(reference: string, title: string): string {
  const line = plain(title).split('\n').map(l => l.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const capped = line.length > TICKET_TEXT_LIMITS.titleChars ? `${line.slice(0, TICKET_TEXT_LIMITS.titleChars - 1).trimEnd()}…` : line;
  return capped ? `${reference}: ${capped}` : reference;
}

/**
 * Ticket text as inert GitHub Markdown: every line quoted, `&`, `<`, `>` as
 * entities, `@` mentions broken with a word joiner. At most `maxBytes` UTF-8
 * bytes once escaped and quoted: a longer quote is cut, never inside an
 * entity, a broken mention or a character, and ends with `…`.
 */
export function inertQuote(text: string, maxBytes = Number.POSITIVE_INFINITY): string {
  const value = plain(text).split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const chars = Array.from(value);
  const capped = chars.length > TICKET_TEXT_LIMITS.descriptionChars ? `${chars.slice(0, TICKET_TEXT_LIMITS.descriptionChars).join('')}${ELLIPSIS}` : value;
  const quoted = capped
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, '$1@\u2060')
    .split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
  if (utf8(quoted) <= maxBytes) return quoted;
  const room = maxBytes - utf8(ELLIPSIS);
  let kept = '';
  let used = 0;
  for (const piece of quoted.match(UNSPLITTABLE) ?? []) {
    const size = utf8(piece);
    if (used + size > room) break;
    kept += piece;
    used += size;
  }
  return room < 0 ? '' : `${kept}${ELLIPSIS}`;
}

export interface TicketHandOff {
  /** The service's stable ticket id: the de-duplication key. */
  id: string;
  /** The human reference, such as `ENG-123`; checked by the plugin. */
  reference: string;
  /** The ticket's URL on the service, checked by the plugin; null when it has none. */
  url: string | null;
  title: string;
  description: string;
  /** From the plugin's mapping, never from the ticket. */
  repository: string;
  /** From the plugin's settings, never from the ticket. */
  githubLabel: string;
  /** The service's name, such as `Linear`. */
  service: string;
  /** The service-side trigger, as the body explains it, such as "adding the `propr` label". */
  trigger: string;
}

export interface HandOffResult { [key: string]: PluginJsonValue; outcome: 'created' | 'duplicate'; ticket: string; repository: string; issue: number | null }

export function ticketIssueBody(handOff: Omit<TicketHandOff, 'id' | 'repository' | 'githubLabel' | 'title'>): string {
  const reference = handOff.reference.replace(/[[\]]/g, '');
  const link = handOff.url ? `[${reference}](${handOff.url})` : reference;
  const intro = `Handed to ProPR from the ${handOff.service} ticket ${link} by ${handOff.trigger}.`;
  const footer = `_Created by the ProPR ${handOff.service} plugin. The repository comes from the plugin's mapping and the label from its settings; the ticket text chooses neither, nor the model. Removing the label or closing the ticket does not cancel the work._`;
  const lead = 'The ticket\'s description, as written:\n\n';
  const body = (section: string) => [intro, '', section, '', footer].join('\n');
  // The description gets what the wrapper leaves of the body's byte budget, measured after escaping.
  const description = inertQuote(handOff.description, ISSUE_BODY_BYTES - utf8(body(lead)));
  return body(description ? `${lead}${description}` : 'The ticket has no description.');
}

/** `ctx.propr.createIssue` refusals that prove no issue was created. */
const NOT_CREATED = new Set(['permission_denied', 'repository_not_allowed', 'invalid_input', 'not_found']);

/**
 * Create the ticket's GitHub issue, once per ticket id. A ticket already
 * recorded (created, or pending because an earlier attempt may have created
 * it) creates nothing. If creating fails in a way that may still have created
 * the issue, the delivery fails and is not retried, so a ticket never
 * produces two issues; a refusal that proves nothing was created forgets the
 * ticket again, so handing it over later can work.
 */
export async function handOffTicket(ctx: PluginContext, handOff: TicketHandOff): Promise<HandOffResult> {
  // Checking and reserving the ticket is one atomic update: of two deliveries for it at once, only one creates its issue.
  const seen = await reserveTicket(ctx, { t: handOff.id, k: handOff.reference, r: handOff.repository });
  if (seen) {
    ctx.log.info(`Ticket ${handOff.reference} was already handed to ProPR; nothing was created`, { ticket: handOff.reference, repository: seen.r, issue: seen.n ?? null });
    return { outcome: 'duplicate', ticket: handOff.reference, repository: seen.r, issue: seen.n ?? null };
  }
  let created: { number: number };
  try {
    created = await ctx.propr.createIssue(handOff.repository, {
      title: ticketIssueTitle(handOff.reference, handOff.title), body: ticketIssueBody(handOff), labels: [handOff.githubLabel],
    });
  } catch (error) {
    if (error instanceof PluginSdkError && NOT_CREATED.has(error.code)) {
      await deleteTicket(ctx, handOff.id);
      throw new PluginDeliveryError(`The issue for ${handOff.reference} was not created in ${handOff.repository}: ${error.message}`, { permanent: true });
    }
    throw new PluginDeliveryError(`Creating the issue for ${handOff.reference} in ${handOff.repository} failed and it may have been created anyway; it is not retried, so a ticket creates at most one issue. Check the repository`, { permanent: true });
  }
  await writeTicket(ctx, { t: handOff.id, k: handOff.reference, r: handOff.repository, s: 'created', n: created.number });
  ctx.log.info(`Created issue #${created.number} in ${handOff.repository} for ticket ${handOff.reference}`, { ticket: handOff.reference, repository: handOff.repository, issue: created.number });
  return { outcome: 'created', ticket: handOff.reference, repository: handOff.repository, issue: created.number };
}
