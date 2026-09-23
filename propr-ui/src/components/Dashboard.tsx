/**
 * Dashboard composition root.
 *
 * The dashboard answers "what needs my attention right now" in five sections:
 * a summary strip, needs attention, happening now, recent outcomes and
 * historical stats. Live work gets the space; the deeper charts live on
 * `/analytics`.
 *
 * This file owns only three things — the shared repository filter, the socket
 * subscription that keeps every section current, and the responsive layout.
 * Each section reads its own slice of the dashboard API.
 *
 * The layout is a split-pane console, not a tray of cards. There are no boxes:
 * the two columns are separated by one continuous vertical rule that runs the
 * full height of the canvas, sub-sections are separated by edge-to-edge
 * horizontal rules, and the panes share row lines so the dividers in the two
 * columns land on the same pixel. The console fills the viewport — the last
 * grid row absorbs the leftover height — so the pane divider never stops
 * halfway down the screen above a band of dead white space.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import { OnboardingWidget } from './Dashboard/OnboardingWidget';
import { NoDefaultModelAlert } from './Dashboard/NoDefaultModelAlert';
import AgentTankDetectionBanner from './AgentTankDetectionBanner';
import { ConnectSoftPromoBanner } from './ConnectPlusBanner';
import { RepositorySelector, type RepoOption } from './RepositorySelector';
import { fetchEnabledRepos } from '../utils/repoHelpers';
import { useSocket } from '../contexts/useSocket';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import { useLiveRefreshScheduler } from '../hooks/useLiveRefreshScheduler';
import { isDefaultParamValue } from './TaskList/utils';
import { formatRelativeTime } from './TaskList/utils.tsx';
import { SummaryStrip } from './Dashboard/SummaryStrip';
import { NeedsAttentionPanel } from './Dashboard/NeedsAttentionPanel';
import { HappeningNowSection } from './Dashboard/HappeningNowSection';
import { RecentOutcomesFeed } from './Dashboard/RecentOutcomesFeed';
import { HistoricalStatsPanel } from './Dashboard/HistoricalStatsPanel';
import { RepositoryIconProvider, type RepositoryIconInfo } from './Dashboard/sectionPrimitives';
import { ALL_REPOSITORIES, REPOSITORY_PARAM, useNowTick } from './Dashboard/sectionState';
import type { TaskUpdatePayload } from '@propr/shared';

/**
 * Connection state for the live sections.
 *
 * A dropped socket never blanks the dashboard: the last known rows stay on
 * screen and this line says how old they are.
 */
const LiveStatus: React.FC<{ isConnected: boolean; lastUpdatedAt: string | null }> = ({
  isConnected,
  lastUpdatedAt,
}) => {
  // Re-render so "last updated" ages while the socket stays down.
  useNowTick(30_000);

  if (isConnected) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-gray-500" data-testid="live-status">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-500" aria-hidden="true" />
        Live
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-700" data-testid="live-status" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      Reconnecting
      {lastUpdatedAt && <> · Last updated {formatRelativeTime(lastUpdatedAt)}</>}
    </p>
  );
};

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
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const taskEventFingerprintsRef = useRef<Map<string, string>>(new Map());

  const markLoaded = useCallback(() => setLastUpdatedAt(new Date().toISOString()), []);
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

  const [attentionEmpty, setAttentionEmpty] = useState(false);
  const sectionProps = { repository, refreshToken, onLoaded: markLoaded };

  return (
    <RepositoryIconProvider icons={repositoryIcons}>
      <div className="flex min-h-full flex-col bg-white">
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 sm:px-6">
          <LiveStatus isConnected={isConnected} lastUpdatedAt={lastUpdatedAt} />
          {(reposLoading || repoOptions.length > 1) && (
            <RepositorySelector
              repos={repoOptions}
              selectedRepo={repository}
              onRepoChange={setRepository}
              isLoading={reposLoading}
              variant="default"
              labelLayout="stacked"
              className="w-full min-w-0 sm:w-[280px] sm:max-w-[280px] sm:flex-none"
            />
          )}
        </div>

        {/*
          The status bar for the whole console, anchored directly above the
          panes rather than floating between the toolbar and the feed.
        */}
        <SummaryStrip {...sectionProps} />

        {/*
          Mobile keeps the DOM order: attention, happening now, recent
          outcomes, historical stats. Desktop places running work and outcomes
          in the main column and the two supporting panels in a narrower right
          column; with nothing to attend to, that panel leaves the layout and
          the stats move up into its place.

          Placement is explicit rather than nested so that DOM order can serve
          mobile while the columns stay real columns. Cells stretch, which is
          what keeps the two columns' row rules on one continuous horizon.

          `flex-1` plus a last row of `minmax(min-content,1fr)` is what makes
          the divider continuous: the bottom row grows into whatever height is
          left — and never shrinks below its content, so a long feed still
          scrolls rather than clipping — so the `lg:border-r` hanging off the
          main column reaches the bottom of the viewport instead of ending
          wherever the content happened to stop. The
          divider hangs off the main column, not the supporting one, because
          the main column is always the taller of the two.
        */}
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_minmax(min-content,1fr)]">
          <div
            className={`min-w-0 border-b border-slate-200 lg:col-start-2 lg:row-start-1 ${
              attentionEmpty ? 'lg:hidden' : ''
            }`}
          >
            <NeedsAttentionPanel {...sectionProps} onEmptyChange={setAttentionEmpty} />
          </div>

          <div className="min-w-0 border-b border-slate-200 lg:col-start-1 lg:row-start-1 lg:border-r">
            <HappeningNowSection {...sectionProps} />
          </div>

          <div className="min-w-0 border-b border-slate-200 lg:col-start-1 lg:row-start-2 lg:border-b-0 lg:border-r">
            <RecentOutcomesFeed {...sectionProps} />
          </div>

          <div
            className={`min-w-0 border-b border-slate-200 lg:col-start-2 lg:border-b-0 ${
              attentionEmpty ? 'lg:row-start-1' : 'lg:row-start-2'
            }`}
          >
            <HistoricalStatsPanel {...sectionProps} />
          </div>
        </div>
      </div>
    </RepositoryIconProvider>
  );
};

export default Dashboard;
