import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';
const CODE = 'text-[11px]';

/** What skills and MCP servers give an agent, shown as the section description. */
export const AgentExtensionsDescription: React.FC = () => (
  <>
    Give agents extra tools for a task. An MCP server is a service the agent can call while it works, such as a
    documentation search or an issue tracker. A skill is a folder of instructions, with a{' '}
    <code className={CODE}>SKILL.md</code> and optional scripts, that the agent reads when it is relevant.
    Only Claude and Codex runs can use extensions.{' '}
    <a href="https://docs.propr.dev/docs/features/agent-extensions" target="_blank" rel="noopener noreferrer" className={LINK}>
      Skills & MCP servers docs
    </a>
  </>
);

/** How library items reach runs, shown above the lists. */
export const AgentExtensionsExplanation: React.FC = () => (
  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700" aria-label="How extensions apply">
    <li>Items apply automatically to issue tasks, pull request follow-ups and automations in matching repositories.</li>
    <li>Untick an item to switch it off everywhere without losing its settings or stored secret; tick it to switch it back on.</li>
    <li>Write servers need the write opt-in on New Task, or an automation action phase that allows writes.</li>
    <li>
      The labels <code className={CODE}>disable-mcps</code>, <code className={CODE}>disable-skills</code> and{' '}
      <code className={CODE}>disable-extensions</code> turn them off for one issue or pull request.
    </li>
    <li>An item with Apply automatically turned off is used only by automations that add it.</li>
  </ul>
);
