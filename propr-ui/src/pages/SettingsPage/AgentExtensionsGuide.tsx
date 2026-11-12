import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';

/** What skills and MCP servers give an agent, shown as the section description. */
export const AgentExtensionsDescription: React.FC = () => (
  <>
    Give agents extra tools for a task. An MCP server is a service the agent can call while it works, such as a
    documentation search or an issue tracker. A skill is a folder of instructions, with a{' '}
    <code className="text-[11px]">SKILL.md</code> and optional scripts, that the agent reads when it is relevant.
    Add them to the instance library once. Each item applies automatically to automation runs in the repositories
    and agents it is limited to; turn off Apply automatically to use an item only where an automation adds it in
    its settings. Only Claude and Codex runs can use extensions.{' '}
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
