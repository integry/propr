/**
 * Happening now: the operational view of work in flight, newest first.
 *
 * Rows show only facts the system actually has — what kind of work it is,
 * elapsed time and what the agent is doing right now. Every row in this list
 * is running, so there is no per-row status badge or spinner repeating it; the
 * pane's heading already says so. There is no synthesised percentage, and a
 * quiet run is not called stalled: the row says when the agent last produced
 * output and leaves the judgement to the person reading it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { getDashboardActive, type ActiveItem, type DashboardActiveResponse } from '../../api/dashboardApi';
import {
  RepositoryLabel,
  RowDetail,
  RowLink,
  RowMetaLines,
  RowTitle,
  SectionEmpty,
  SectionError,
  SectionFooter,
  SectionFooterButton,
  SectionHeading,
  SectionLink,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedRunning,
  filteredTasksHref,
  lastOutputLabel,
  primaryClause,
  shortenPaths,
  useDashboardSection,
  useNowTick,
  useStableOrder,
  workHref,
} from './sectionState';
import { splitWorkTitle } from './workTitle';

/** Active rows shown before the list has to be expanded. */
const VISIBLE_ITEMS = 5;

/**
 * Rows the list will simply draw rather than fold behind a control.
 *
 * A "Show 1 more" toggle costs a line of chrome to save a line of content and
 * asks for a click to reveal a single row. Past the slack the toggle earns its
 * place; at or below it the row is just shown.
 */
const OVERFLOW_SLACK = 1;

const itemKey = (item: ActiveItem): string => item.id;

/** The server's order for running work: newest run first, by when it was created. */
const newestRunFirst = (a: ActiveItem, b: ActiveItem): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

const fallbackTitle = (item: ActiveItem): string =>
  item.prNumber ? `Pull request #${item.prNumber}` : item.issueNumber ? `Issue #${item.issueNumber}` : 'Untitled work';

/** States in which the agent itself is running, so its stream is current. */
const AGENT_STATES = new Set(['claude_execution', 'active']);

/**
 * The lifecycle phase, said as what the system is doing.
 *
 * Only for the stretches either side of the agent, where there is no agent
 * stream to read. "Implementing" is not here on purpose: the type badge and
 * the pane already say that, and the agent's own line says more.
 */
const LIFECYCLE_LINES: Record<string, string> = {
  processing: 'Setting up the workspace',
  post_processing: 'Publishing the results',
};

/**
 * The live sub-phase: what this run is doing right now.
 *
 * Setting up and publishing are said as the lifecycle phase, whatever the
 * stream holds: the agent has not started, or has finished, and its last plan
 * step or tool call is history rather than the current phase. While the agent
 * is the one running, its own plan step comes first — it is the line the agent
 * chose to describe its work with — and without one, the latest tool call it
 * made says what it is actually touching.
 *
 * An agent with nothing in its stream yet says exactly that, but only when the
 * stream was read and found empty. A stream that could not be read, or output
 * that names no action (the agent thinking, say), is an unknown action, not a
 * run waiting to start.
 */
function subPhase(item: ActiveItem): string {
  if (!AGENT_STATES.has(item.state)) return LIFECYCLE_LINES[item.state] ?? item.phase ?? 'Starting';
  if (item.progressLine) return item.progressLine;
  if (item.activity) return item.activity;
  return item.awaitingFirstOutput ? 'Waiting for the agent\'s first output' : 'Current action not reported';
}

/**
 * One running row: the whole row is the link to the work it names.
 *
 * There is no disclosure chevron. A chevron on the edge of a feed row promises
 * an accordion, and this row does not open one — clicking it navigates to the
 * task, which is where the phase history, the timings and the full progress
 * line already live. Drawing both a link and a fold made the row claim two
 * different behaviours, and on a phone the arrow also sat two pixels from the
 * elapsed time it was crowding. The row has one behaviour and the space back.
 */
const ActiveRow: React.FC<{ item: ActiveItem }> = ({ item }) => {
  const work = splitWorkTitle(item.title, item.taskType);
  const line = subPhase(item);
  const agentRunning = AGENT_STATES.has(item.state);
  const lastOutputAt = agentRunning ? item.lastActivityAt ?? null : null;
  const step = agentRunning ? item.step ?? null : null;
  return (
    <li>
      <RowLink href={workHref(item)} className="block min-w-0 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500">
        <RowMetaLines
          entities={(
            <>
              <RepositoryLabel repository={item.repository} />
              <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
            </>
          )}
          trailing={(
            <span title={`Started ${new Date(item.createdAt).toLocaleString()}${item.phase ? ` · ${item.phase}` : ''}`}>
              {elapsedRunning(item.createdAt)}
            </span>
          )}
        />
        <RowTitle type={work.type}>{work.title ?? fallbackTitle(item)}</RowTitle>
        {/*
          Every running row carries this line; a row without it is a title and
          a ticking timer, which cannot tell a working agent from a hung one.

          The line is a sentence with a repository path in it, and on a phone
          the path is most of the sentence: 110 characters of
          `propr-ui/src/components/…` wrapped to three lines of the densest text
          on the screen. Someone triaging on a phone needs the file, not the
          route to it, so the directories collapse below `sm` and come back
          whole where there is width for them — and the sentence stops at its
          first clause rather than being cut mid-word by the clamp.

          The plan step and the time since the agent last produced output ride
          at the end of the line, and the sentence gives way to them.
        */}
        <RowDetail
          data-testid="running-sub-phase"
          trailing={(step || lastOutputAt) && (
            <>
              {step && (
                <span data-testid="running-step" title="Step in the agent's own plan">
                  step {step.current}/{step.total}
                </span>
              )}
              {lastOutputAt && (
                <span data-testid="running-last-output" title={`Last agent output ${new Date(lastOutputAt).toLocaleString()}`}>
                  <span className="hidden sm:inline">last output </span>
                  {lastOutputLabel(lastOutputAt)}
                </span>
              )}
            </>
          )}
        >
          <span className="sm:hidden">{shortenPaths(primaryClause(line))}</span>
          <span className="hidden sm:inline" title={agentRunning && item.activity && item.activity !== line ? `Latest action: ${item.activity}` : undefined}>
            {line}
          </span>
        </RowDetail>
      </RowLink>
    </li>
  );
};

/**
 * The one footer under the running list.
 *
 * Waiting work is summarised rather than listed, and the control that unfolds
 * the rest of the list rides in the same bar. Two pieces of after-the-list
 * chrome — a floating link above a tinted strip — read as an accident; one bar
 * reads as the end of the pane.
 */
const HappeningNowFooter: React.FC<{
  queuedCount: number;
  reason: string | null;
  repository: string;
  overflowCount: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ queuedCount, reason, repository, overflowCount, expanded, onToggle }) => {
  const showToggle = overflowCount > 0;
  if (queuedCount === 0 && !showToggle) return null;
  return (
    <SectionFooter data-testid="happening-now-footer">
      {queuedCount > 0 && (
        <span data-testid="queue-summary" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-medium text-slate-700 ${reason ? 'border-r border-slate-300 pr-2' : ''}`}>
            {queuedCount} queued
          </span>
          {reason && <span>{reason}</span>}
        </span>
      )}
      <span className="ml-auto flex items-center gap-x-3">
        {showToggle && (
          <SectionFooterButton expanded={expanded} onClick={onToggle}>
            {expanded ? 'Show fewer' : `Show ${overflowCount} more`}
          </SectionFooterButton>
        )}
        {queuedCount > 0 && (
          <SectionLink to={filteredTasksHref('waiting', repository)}>View queue</SectionLink>
        )}
      </span>
    </SectionFooter>
  );
};

export const HappeningNowSection: React.FC<DashboardSectionProps> = ({ repository, refreshToken }) => {
  const load = useCallback(() => getDashboardActive(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardActiveResponse>(
    load,
    repository,
    refreshToken,
  );
  const [showAll, setShowAll] = useState(false);
  // Elapsed times advance between reads.
  useNowTick();

  const running = useMemo(() => data?.running ?? [], [data]);
  const orderedRunning = useStableOrder(running, itemKey, newestRunFirst);
  // One row over the limit is drawn, not folded: see OVERFLOW_SLACK.
  const canCollapse = orderedRunning.length > VISIBLE_ITEMS + OVERFLOW_SLACK;
  const collapsedLimit = canCollapse ? VISIBLE_ITEMS : orderedRunning.length;
  const overflowCount = canCollapse ? orderedRunning.length - VISIBLE_ITEMS : 0;

  const heading = (
    <SectionHeading id="happening-now-heading" title="Happening now" count={data?.counts.running ?? null}>
      <SectionLink to={filteredTasksHref('active', repository)}>View all</SectionLink>
    </SectionHeading>
  );

  const body = () => {
    if (loading) return <SectionSkeleton rows={3} />;
    // "We could not find out" is not the same as "nothing is running", so the
    // failed read keeps its own wording and its own retry.
    if (error && orderedRunning.length === 0) {
      return <SectionError message="Unable to load running work" onRetry={reload} />;
    }
    if (orderedRunning.length === 0) {
      return <SectionEmpty>No work running</SectionEmpty>;
    }

    const visible = showAll ? orderedRunning : orderedRunning.slice(0, collapsedLimit);
    return (
      <ul data-testid="happening-now-list">
        {visible.map(item => (
          <ActiveRow key={item.id} item={item} />
        ))}
      </ul>
    );
  };

  /*
    The pane is a column with a floor, not a stack that stops where its rows
    do. Its height is set by whichever pane is taller in the row, so a single
    running task beside three attention items left the queue bar stranded
    mid-pane above a band of white. The list area takes the slack instead, and
    the footer closes the pane against the rule under it.
  */
  return (
    <section
      aria-labelledby="happening-now-heading"
      data-testid="happening-now-section"
      className="flex h-full min-w-0 flex-col bg-white"
    >
      {heading}
      <div className="flex-1">{body()}</div>
      {data && (
        <HappeningNowFooter
          queuedCount={data.queue.queuedCount}
          reason={data.queue.reason}
          repository={repository}
          overflowCount={overflowCount}
          expanded={showAll}
          onToggle={() => setShowAll(value => !value)}
        />
      )}
    </section>
  );
};

export default HappeningNowSection;
