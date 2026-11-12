/**
 * Repository event commands
 *
 * `propr events list` reads a repository's durable change-event journal after
 * a cursor; `propr events wait` blocks (bounded) until a matching event
 * exists. `--follow` keeps going on the returned cursor until Ctrl-C.
 * Delivery is at-least-once: resume with the last cursor you processed.
 */

import { Command } from "commander";
import {
  REPOSITORY_EVENT_ALL_TYPES,
  REPOSITORY_EVENT_DOMAINS,
  REPOSITORY_EVENT_LIST_MAX_LIMIT,
  REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS,
  REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS,
  type RepositoryEventDomain,
  type RepositoryEventView,
} from "@propr/shared";
import { listRepositoryEvents, waitRepositoryEvents, type RepositoryEventQuery } from "../api/repositoryEvents.js";
import { ApiError, RequestCancelledError } from "../api/errors.js";
import { createConfigManager } from "../config/index.js";
import { parsePositiveInteger, resolveProject, ProjectResolutionError } from "../utils/index.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

/** `propr events wait` exit codes: events found, timed out, interrupted. */
export const EVENTS_WAIT_EXIT_CODES = { events: 0, timeout: 2, interrupted: 130 } as const;

class EventsUsageError extends Error {}

interface EventOptions {
  project?: string;
  afterCursor?: string;
  fromStart?: boolean;
  domain?: string;
  type?: string;
  pr?: string;
  plan?: string;
  limit?: string;
  timeout?: string;
  follow?: boolean;
  json?: boolean;
}

function csv(value: string | undefined): string[] | undefined {
  const values = value?.split(",").map(item => item.trim()).filter(Boolean);
  return values?.length ? [...new Set(values)] : undefined;
}

/** Validate the shared filter options into a query. */
export function parseEventQuery(options: EventOptions, repository: string): RepositoryEventQuery {
  const domains = csv(options.domain);
  const unknownDomain = domains?.find(domain => !(REPOSITORY_EVENT_DOMAINS as readonly string[]).includes(domain));
  if (unknownDomain) throw new EventsUsageError(`--domain must be among: ${REPOSITORY_EVENT_DOMAINS.join(", ")} (got ${unknownDomain}).`);
  const types = csv(options.type);
  const unknownType = types?.find(type => !REPOSITORY_EVENT_ALL_TYPES.includes(type));
  if (unknownType) throw new EventsUsageError(`--type must be among: ${REPOSITORY_EVENT_ALL_TYPES.join(", ")} (got ${unknownType}).`);
  const limit = options.limit === undefined ? undefined : parsePositiveInteger(options.limit, "--limit");
  if (limit !== undefined && limit > REPOSITORY_EVENT_LIST_MAX_LIMIT) throw new EventsUsageError(`--limit must be at most ${REPOSITORY_EVENT_LIST_MAX_LIMIT}.`);
  return {
    repository,
    afterCursor: options.afterCursor,
    fromStart: options.fromStart ?? false,
    domains: domains as RepositoryEventDomain[] | undefined,
    types,
    pullRequest: options.pr === undefined ? undefined : parsePositiveInteger(options.pr, "--pr"),
    planId: options.plan,
    limit,
  };
}

export function parseWaitTimeout(value: string | undefined): number {
  if (value === undefined) return REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS;
  const parsed = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || parsed > REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS) {
    throw new EventsUsageError(`--timeout must be a number from 0 to ${REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return parsed;
}

/** One human-readable line per event. */
export function formatEvent(event: RepositoryEventView): string {
  const subject = event.pullRequest !== undefined ? `#${event.pullRequest}`
    : event.issueNumber !== undefined ? `issue #${event.issueNumber}` : event.entityId;
  const payload = Object.entries(event.payload)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([key, value]) => `${key}=${String(value)}`).join(" ");
  const head = event.head ? ` @${event.head.slice(0, 12)}` : "";
  const plan = event.planId ? ` plan ${event.planId}` : "";
  return `${event.occurredAt}  ${event.domain}/${event.type}  ${subject}${head}${plan}${payload ? `  ${payload}` : ""}`;
}

function printEvents(events: RepositoryEventView[], json: boolean): void {
  for (const event of events) console.log(json ? JSON.stringify(event) : formatEvent(event));
}

const FILTER_HELP = `
Filters (comma-separated):
  --domain ${REPOSITORY_EVENT_DOMAINS.join(",")}
  --type   ${REPOSITORY_EVENT_ALL_TYPES.join(",")}

Without --after-cursor a read starts at the current end of the journal (it
prints the current cursor and no history) unless --from-start is given.
Delivery is at-least-once and ordered: resume with the last cursor you
processed. With --follow and --json, each event is printed as one JSON line.`;

function addFilterOptions(command: Command): Command {
  return command
    .option("-p, --project <project>", "Repository (owner/repo); defaults to the configured project")
    .option("--after-cursor <cursor>", "Only events after this cursor")
    .option("--from-start", "Without a cursor, start at the oldest retained event")
    .option("--domain <domains>", "Only these domains")
    .option("--type <types>", "Only these event types")
    .option("--pr <number>", "Only events of this pull request")
    .option("--plan <planId>", "Only events of this plan")
    .option("--limit <n>", `Most events per request (max ${REPOSITORY_EVENT_LIST_MAX_LIMIT})`)
    .option("--follow", "Keep reading on the returned cursor until interrupted")
    .option("--json", "Output raw JSON");
}

function reportError(error: unknown, json: boolean | undefined): void {
  if (error instanceof EventsUsageError || error instanceof ProjectResolutionError) {
    console.error(`Error: ${error.message}`);
    return;
  }
  const body = error instanceof ApiError ? error.response as { code?: string; message?: string; hint?: string } | undefined : undefined;
  const code = body?.code;
  if (code && (code.startsWith("CURSOR_") || code === "WAIT_LIMIT" || code === "INVALID_INPUT")) {
    if (json) console.log(JSON.stringify({ error: body.message ?? (error as Error).message, code, hint: body.hint ?? null }, null, 2));
    else console.error(`Error (${code}): ${body.message ?? (error as Error).message}${body.hint ? `\n${body.hint}` : ""}`);
    return;
  }
  presentApiError(error, {
    forbiddenMessage: "Error: Access denied. You cannot read this repository's events.",
    fallbackMessage: message => `Error reading repository events: ${message}`,
  });
}

/**
 * Follow the journal from a cursor: wait, print, repeat. Returns when
 * interrupted; the last processed cursor is printed so a later run resumes.
 */
async function follow(query: RepositoryEventQuery, timeoutSeconds: number, json: boolean, state: { cursor?: string; signal: AbortSignal }): Promise<void> {
  let first = state.cursor === undefined;
  while (!state.signal.aborted) {
    const result = await waitRepositoryEvents({ ...query, afterCursor: state.cursor, fromStart: first && query.fromStart, timeoutSeconds }, { signal: state.signal });
    first = false;
    printEvents(result.events, json);
    state.cursor = result.cursor;
  }
}

async function run(options: EventOptions, wait: boolean): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  const state: { cursor?: string; signal: AbortSignal } = { cursor: options.afterCursor, signal: controller.signal };
  try {
    const query = parseEventQuery(options, resolveProject(options, await createConfigManager()));
    const timeoutSeconds = wait ? parseWaitTimeout(options.timeout) : REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS;
    if (options.follow) {
      let start = query;
      if (!wait) {
        // List first (one page at a time), then wait on the cursor.
        for (let page = await listRepositoryEvents(query); ; page = await listRepositoryEvents({ ...query, afterCursor: page.cursor, fromStart: false })) {
          printEvents(page.events, options.json ?? false);
          state.cursor = page.cursor;
          if (!page.truncated) break;
        }
        start = { ...query, fromStart: false };
      }
      await follow(start, timeoutSeconds, options.json ?? false, state);
      return EVENTS_WAIT_EXIT_CODES.interrupted;
    }
    const result = wait ? await waitRepositoryEvents({ ...query, timeoutSeconds }, { signal: controller.signal }) : await listRepositoryEvents(query);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printEvents(result.events, false);
      if (!result.events.length) console.log(wait ? "No matching events before the timeout." : "No events after the cursor.");
      console.log(`Cursor: ${result.cursor}${result.truncated ? " (more events follow; read again with this cursor)" : ""}`);
    }
    return wait && result.events.length === 0 ? EVENTS_WAIT_EXIT_CODES.timeout : EVENTS_WAIT_EXIT_CODES.events;
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      console.error(`Stopped reading events.${state.cursor ? ` Resume with --after-cursor ${state.cursor}` : ""}`);
      return EVENTS_WAIT_EXIT_CODES.interrupted;
    }
    reportError(error, options.json);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export function createEventsCommand(): Command {
  const events = new Command("events").description("Read and wait on a repository's change events (pull requests, epic queues, plan issues)");
  events.addCommand(addFilterOptions(new Command("list")
    .description("List change events after a cursor"))
    .addHelpText("after", `${FILTER_HELP}

Examples:
  $ propr events list --from-start --pr 42
  $ propr events list --after-cursor <cursor> --domain pull_request --json
  $ propr events list --follow --type merged,closed
`)
    .action(async (options: EventOptions) => {
      const code = await run(options, false);
      if (code !== 0) process.exit(code);
    }));
  events.addCommand(addFilterOptions(new Command("wait")
    .description("Wait, bounded, for a matching change event after a cursor"))
    .option("--timeout <seconds>", `Seconds to wait per request (default ${REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS}, max ${REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS})`)
    .addHelpText("after", `${FILTER_HELP}

Exit codes: ${EVENTS_WAIT_EXIT_CODES.events} events, ${EVENTS_WAIT_EXIT_CODES.timeout} timeout (cursor unchanged), 1 error, ${EVENTS_WAIT_EXIT_CODES.interrupted} interrupted.

Examples:
  $ propr events wait --after-cursor <cursor> --pr 42
  $ propr events wait --follow --domain epic_queue --json
`)
    .action(async (options: EventOptions) => {
      const code = await run(options, true);
      if (code !== 0) process.exit(code);
    }));
  return events;
}
