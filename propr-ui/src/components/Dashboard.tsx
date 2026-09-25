/**
 * Dashboard composition root.
 *
 * The dashboard answers "what needs my attention right now" in four panes:
 * needs attention, happening now, completed and historical stats. Live
 * work gets the space; the deeper charts live on `/analytics`. The page spends
 * no row of its own on a title or a toolbar: the panes start directly under the
 * global header, and the repository filter lives in that header.
 *
 * This file owns only three things — the shared repository filter, the socket
 * subscription that keeps every section current, and the responsive layout.
 * Each section reads its own slice of the dashboard API.
 *
 * The layout is a split-pane console, not a tray of cards. There are no boxes,
 * and a rule is spent only where a pane actually ends: one continuous vertical
 * rule between the columns, one horizontal rule under each pane header and
 * between the stacked panes. Everything inside a pane — rows, counts, metrics,
 * segmented controls — is separated by space and tint instead, because a rule
 * repeated on every row stops reading as structure and starts reading as
 * texture. The panes share row lines so the dividers in the two columns land
 * on the same pixel. The console fills the viewport — the last
 * grid row absorbs the leftover height — so the pane divider never stops
 * halfway down the screen above a band of dead white space.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import { OnboardingWidget } from './Dashboard/OnboardingWidget';
import { NoDefaultModelAlert } from './Dashboard/NoDefaultModelAlert';
import AgentTankDetectionBanner from './AgentTankDetectionBanner';
import { ConnectSoftPromoBanner } from './ConnectPlusBanner';
import { RepositorySelector, type RepoOption } from './RepositorySelector';
import { useHeaderScopeSlot } from './headerScopeSlot';
import { fetchEnabledRepos } from '../utils/repoHelpers';
import { useSocket } from '../contexts/useSocket';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import { useLiveRefreshScheduler } from '../hooks/useLiveRefreshScheduler';
import { isDefaultParamValue } from './TaskList/utils';
import { NeedsAttentionPanel } from './Dashboard/NeedsAttentionPanel';
import { HappeningNowSection } from './Dashboard/HappeningNowSection';
import { CompletedFeed } from './Dashboard/CompletedFeed';
import { HistoricalStatsPanel } from './Dashboard/HistoricalStatsPanel';
import { RepositoryIconProvider, type RepositoryIconInfo } from './Dashboard/sectionPrimitives';
import { ALL_REPOSITORIES, REPOSITORY_PARAM } from './Dashboard/sectionState';
import type { TaskUpdatePayload } from '@propr/shared';

const Dashboard: React.FC = () => {
  useDocumentTitle('Dashboard');
  const currentUser = useCurrentUser();
  const canManageAgents = userHasPermission(currentUser, 'instance.manage_agents');
  const canManageSettings = userHasPermission(currentUser, 'instance.manage_settings');

  const { hasAgents, hasDefaultModel, hasRepos, hasTasks, isLoading: readinessLoading } = useSystemReadiness();
  const showOnboarding = canManageSettings && !readinessLoading && (!hasAgents || !hasRepos || !hasTasks);

  // One repository filter for every section, kept in the URL so it survives
  // navigation and a reload.
  const [searchParams, setSearchParams] = useSearchParams();
  const repository = searchParams.get(REPOSITORY_PARAM) || ALL_REPOSITORIES;
  const setRepository = useCallback((value: string) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (isDefaultParamValue(value)) next.delete(REPOSITORY_PARAM);
      else next.set(REPOSITORY_PARAM, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetchEnabledRepos()
      .then(loaded => { if (active) setRepos(loaded); })
      .catch(() => { /* The filter falls back to every repository. */ })
      .finally(() => { if (active) setReposLoading(false); });
    return () => { active = false; };
  }, []);

  const repoOptions = useMemo<RepoOption[]>(() => [
    { name: ALL_REPOSITORIES, enabled: true, displayName: 'All Repos' },
    ...[...repos].sort((left, right) => left.name.localeCompare(right.name)),
  ], [repos]);

  const repositoryIcons = useMemo(() => {
    const icons = new Map<string, RepositoryIconInfo>();
    for (const repo of repos) icons.set(repo.name, { iconPath: repo.iconPath, revision: repo.iconRevision });
    return icons;
  }, [repos]);

  // Live updates. One coalesced refresh per burst of task events bumps a token
  // every section reads, so ten events in a row cost one request per section.
  const { onTaskUpdate, isConnected } = useSocket();
  const [refreshToken, setRefreshToken] = useState(0);
  const taskEventFingerprintsRef = useRef<Map<string, string>>(new Map());

  const scheduleLiveRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: () => setRefreshToken(token => token + 1),
  });

  useEffect(() => {
    if (!isConnected) return;
    const handleTaskUpdate = (payload: TaskUpdatePayload) => {
      const fingerprint = `${payload.state}\0${payload.repository ?? ''}\0${payload.issueNumber ?? ''}`;
      if (taskEventFingerprintsRef.current.get(payload.taskId) === fingerprint) return;
      taskEventFingerprintsRef.current.set(payload.taskId, fingerprint);
      scheduleLiveRefresh();
    };
    return onTaskUpdate(handleTaskUpdate);
  }, [isConnected, onTaskUpdate, scheduleLiveRefresh]);

  const sectionProps = { repository, refreshToken };

  const headerScopeSlot = useHeaderScopeSlot();
  const showRepositoryFilter = reposLoading || repoOptions.length > 1;
  const repositoryFilterProps = {
    repos: repoOptions,
    selectedRepo: repository,
    onRepoChange: setRepository,
    isLoading: reposLoading,
  };

  return (
    <RepositoryIconProvider icons={repositoryIcons}>
      {/*
        The phone gets a gap under the last pane. The app shell already pads
        the scrolling canvas by exactly the height of the fixed bottom
        navigation, which clears the bar to the pixel and leaves the final
        metric row and the daily chart sitting flush against its top rule — the
        last thing on the page reads as something the navigation is cutting
        off. A little more than the bar's own height is what makes the end of
        the console look like the end of the console.
      */}
      <div className="flex min-h-full flex-col bg-white pb-6 md:pb-0">
        {/*
          The page's name is carried by the highlighted navigation — the
          sidebar on a desktop, the bottom tab on a phone — so it is not
          printed again above the console. Assistive technology still gets it.
        */}
        <h1 className="sr-only">Dashboard</h1>

        {/*
          The repository filter scopes every pane, so it goes where scope
          belongs rather than on a row of its own.

          From `lg` up the filter mounts in the global toolbar, immediately
          left of search: the panes then start directly under that toolbar's
          rule, with no page bar between them. A 36px bar holding a title on
          the left and this filter on the right spent a full row and 800px of
          empty width on one control.

          On a phone there is no global toolbar, and on a tablet it has no
          width to spare, so there the filter becomes the title bar itself —
          centered, full width and sticky, the way a native app's scope
          switcher is. Nothing sits beside it, so a repository named
          `payment-gateway` gets the whole row instead of the half a static
          "Dashboard" label used to leave it.
        */}
        {showRepositoryFilter && headerScopeSlot && createPortal(
          <RepositorySelector
            {...repositoryFilterProps}
            variant="default"
            size="compact"
            className="w-36 xl:w-48"
          />,
          headerScopeSlot,
        )}
        {showRepositoryFilter && (
          <div
            data-testid="dashboard-scope-bar"
            className="sticky top-0 z-10 flex h-11 flex-none items-center border-b border-slate-200 bg-white px-3 lg:hidden"
          >
            <RepositorySelector
              {...repositoryFilterProps}
              variant="default"
              appearance="title"
              className="w-full"
            />
          </div>
        )}

        <ConnectSoftPromoBanner />

        {canManageAgents && !readinessLoading && (!hasAgents || !hasDefaultModel) && (
          <div className="px-4 pt-4 sm:px-6">
            <NoDefaultModelAlert hasAgents={hasAgents} hasDefaultModel={hasDefaultModel} />
          </div>
        )}

        {showOnboarding && (
          <div className="px-4 pt-4 sm:px-6">
            <OnboardingWidget hasAgents={hasAgents} hasRepos={hasRepos} hasTasks={hasTasks} />
          </div>
        )}

        {canManageAgents && (
          <div className="px-4 pt-4 sm:px-6">
            <AgentTankDetectionBanner />
          </div>
        )}

        {/*
          Mobile keeps the DOM order: attention, happening now, completed,
          historical stats. Desktop puts running work and completed work in
          the main column and the two supporting panels in a narrower right
          column, in that same order of priority: triage at the top of the
          rail, background numbers underneath it.

          Every cell is unconditional. An earlier version dropped the attention
          panel from the desktop grid once its list was empty and moved the
          stats panel up into row one; the right column then ended where the
          stats did, roughly a third of the way down, and the rule between the
          columns carried on alone through the white space below it. A pane
          that comes and goes with its data is not structure, so the panel
          stays and says "all clear" instead.

          Placement is explicit rather than nested so that DOM order can serve
          mobile while the columns stay real columns. Cells stretch, so row one
          is as tall as the taller of its two panes and the rule beneath it is
          one continuous line across both columns.

          `flex-1` plus a last row of `minmax(min-content,1fr)` is what makes
          the vertical divider continuous: the bottom row grows into whatever
          height is left — and never shrinks below its content, so a long feed
          still scrolls rather than clipping — so the `lg:border-r` hanging off
          the main column reaches the bottom of the viewport instead of ending
          wherever the content happened to stop. The divider hangs off the main
          column, not the supporting one, because the main column is always the
          taller of the two.
        */}
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_minmax(min-content,1fr)]">
          <div className="min-w-0 border-b border-slate-200 lg:col-start-2 lg:row-start-1">
            <NeedsAttentionPanel {...sectionProps} />
          </div>

          <div className="min-w-0 border-b border-slate-200 lg:col-start-1 lg:row-start-1 lg:border-r">
            <HappeningNowSection {...sectionProps} />
          </div>

          <div className="min-w-0 border-b border-slate-200 lg:col-start-1 lg:row-start-2 lg:border-b-0 lg:border-r">
            <CompletedFeed {...sectionProps} />
          </div>

          <div className="min-w-0 border-b border-slate-200 lg:col-start-2 lg:row-start-2 lg:border-b-0">
            <HistoricalStatsPanel {...sectionProps} />
          </div>
        </div>
      </div>
    </RepositoryIconProvider>
  );
};

export default Dashboard;
