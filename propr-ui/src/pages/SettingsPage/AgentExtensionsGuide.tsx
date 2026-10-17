import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';

/** What skills and MCP servers give an agent, shown as the section description. */
export const AgentExtensionsDescription: React.FC = () => (
  <>
    Give agents extra tools for a task. An MCP server is a service the agent can call while it works, such as a
    documentation search or an issue tracker. A skill is a folder of instructions, with a{' '}
    <code className="text-[11px]">SKILL.md</code> and optional scripts, that the agent reads when it is relevant.
    Group them into a profile, then choose that profile in New Task or in an automation’s settings. Runs without a
    profile get neither. Only Claude and Codex task runs can use profiles.{' '}
    <a
      href="https://docs.propr.dev/docs/features/agent-extensions"
      target="_blank"
      rel="noopener noreferrer"
      className={LINK}
    >
      Skills & MCP servers docs
    </a>
  </>
);
