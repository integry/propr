import React from 'react';
import type { HistoryItem } from './types';

/** Which agent CLI version the run used, and whether that was a previous version. */
export const AgentRuntimeDetail: React.FC<{ metadata?: HistoryItem['metadata']; inline?: boolean }> = ({ metadata, inline = false }) => {
  const runtime = metadata?.agentRuntime;
  if (!runtime) return null;
  const version = `${runtime.agentType} CLI ${runtime.cliVersion ?? 'unknown'}`;
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      className={`${inline ? 'block text-[11px]' : 'mt-1 text-xs'} break-words ${runtime.configuredCliVersion ? 'text-amber-700' : 'text-slate-500'}`}
      title={runtime.image}
      data-testid="agent-runtime-detail"
    >
      {runtime.agentAlias} · {version}
      {runtime.configuredCliVersion && ` (configured ${runtime.configuredCliVersion} was still being prepared)`}
    </Tag>
  );
};
