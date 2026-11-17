import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';

/** What skills and MCP servers give an agent, shown as the section description. */
export const AgentExtensionsDescription: React.FC = () => (
  <>
    MCP servers give agents extra tools, such as a documentation search or an issue tracker. Skills are folders of
    instructions the agent reads when they are relevant.{' '}
    <a href="https://docs.propr.dev/docs/features/agent-extensions" target="_blank" rel="noopener noreferrer" className={LINK}>
      Skills & MCP servers docs
    </a>
  </>
);
