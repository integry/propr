import type { SettingsCategoryId } from './SettingsNavigation';

export interface SettingsCategoryGuide {
  /** One or two sentences on what the category controls. */
  summary: string;
  /** Behaviour that is hard to infer from the controls alone. */
  notes: string[];
  links: { label: string; href: string }[];
}

const DOCS = 'https://docs.propr.dev/docs';

/**
 * Background shown in the Settings inspector beside each category. Every note
 * restates documented behaviour; follow the links for the full rules.
 * settingsCategoryGuides.test.ts checks each link against the docs tree.
 */
export const SETTINGS_CATEGORY_GUIDES: Record<SettingsCategoryId, SettingsCategoryGuide> = {
  general: {
    summary: 'Preferences for how ProPR presents work to you. Nothing here changes how agents run.',
    notes: [
      'Usage tips are ranked about once a day from activity in this instance. Dismissing a tip hides it for 45 days.',
      'Voice briefings are experimental and off by default. Turning them on does not start audio or ask for the microphone.',
    ],
    links: [
      { label: 'Usage tips', href: `${DOCS}/features/usage-tips` },
      { label: 'Voice briefings', href: `${DOCS}/features/voice-briefings` },
    ],
  },
  models: {
    summary: 'ProPR addresses models by stable model IDs, so the same ID works in issue labels, the CLI and PR commands such as /switch.',
    notes: [
      'When the summarization model hits a provider quota, indexing switches to the fallback model and keeps going instead of failing.',
      'Repositories are reindexed daily by default. Reindex All Repositories queues them all now, unless a quota cooldown is active.',
    ],
    links: [
      { label: 'Agents and models', href: `${DOCS}/features/agents-and-models` },
      { label: 'Repository knowledge', href: `${DOCS}/features/repository-knowledge` },
    ],
  },
  workflow: {
    summary: 'When ProPR picks up GitHub work, who may trigger it, and how issues and pull requests are labelled along the way.',
    notes: [
      'A processing label such as AI moves through AI-processing to AI-done, or AI-failed-* when a run fails.',
      'An empty trigger whitelist lets every GitHub user start work.',
      'A task’s own spend cap and a repository’s limits.max_cost_usd in .propr/workflow.yml take precedence over the default cap.',
    ],
    links: [
      { label: 'PR follow-up', href: `${DOCS}/features/pr-followup` },
      { label: 'Repository workflow file', href: `${DOCS}/features/repository-workflow` },
    ],
  },
  ultrafix: {
    summary: '/ultrafix alternates review and fix cycles until the latest review score reaches the target or Max Cycles runs out.',
    notes: [
      'Escalation compares each review with the best score so far in the run: 6 → 6 or lower is a stall, 6 → 7 resets patience.',
      'After Patience stalled reviews, the current model climbs one reasoning tier. Once it has climbed Max Reasoning Levels times, the next model in the chain takes over at its base effort.',
      'Remove the ultrafix label from a pull request to stop the loop after the current cycle.',
    ],
    links: [
      { label: '/ultrafix', href: `${DOCS}/features/pr-commands#ultrafix` },
      { label: 'Automatic escalation', href: `${DOCS}/features/pr-commands#automatic-escalation` },
    ],
  },
  sandbox: {
    summary: 'Restricted mode starts agent containers with no network interface. Their only route out is a per-run proxy that accepts allowlisted hosts.',
    notes: [
      'GitHub, npm and PyPI hosts are always allowed. *.example.com matches subdomains but not example.com itself. Without a port, an entry allows 80 and 443.',
      'Private and loopback addresses are refused unless you list the IP literal here, for example 10.0.0.5:5000.',
      'Only HTTP(S) goes through the proxy, so Git remotes must use HTTPS rather than SSH.',
      'Each restricted run adds a Restricted Network event to the task timeline listing the hosts it denied.',
      'The agent watchdog applies to every agent run, not only Ultrafix. A silent or whitespace-only run is stopped and its partial work is published.',
    ],
    links: [
      { label: 'Restricted network mode', href: `${DOCS}/features/execution-safety#restricted-network-mode` },
      { label: 'Agent watchdog', href: `${DOCS}/architecture/worker#stall-and-degenerate-output-watchdog` },
    ],
  },
  'agent-extensions': {
    summary: 'What agents can use inside their containers beyond the repository: MCP tools, skills and extra system packages.',
    notes: [
      'An extension profile authorizes specific MCP tools and attaches read-only skill bundles. Claude and Codex task runs select at most one profile.',
      'Agents run without sudo, so system tools such as chromium or ffmpeg must be added as runtime packages. ProPR rebuilds every agent image and keeps the previous images until the build succeeds.',
      'Runtime packages use Debian apt names. Repository-specific npm or pip dependencies belong in .propr/setup.sh.',
    ],
    links: [
      { label: 'Skills & MCP servers', href: `${DOCS}/features/agent-extensions` },
      { label: 'Runtime packages', href: `${DOCS}/features/propr-cli#agent-runtime-packages` },
    ],
  },
  integrations: {
    summary: 'Optional services around the agents. ProPR works the same without them.',
    notes: [
      'Agent Tank reads subscription usage limits from the agent CLIs on your machine. It does not track API spend.',
      'The MCP server is off by default. A connected client never gets more than the scope ceiling set here.',
    ],
    links: [
      { label: 'Agent Tank', href: `${DOCS}/operations/agent-tank` },
      { label: 'MCP connections', href: `${DOCS}/features/mcp` },
      { label: 'Visual previews', href: `${DOCS}/features/visual-previews` },
    ],
  },
  notifications: {
    summary: 'Personal preferences: every member chooses their own.',
    notes: [
      'An Inbox event does not guarantee a push notification. Browser support, permission and the server’s push setup decide delivery.',
      'To silence one repository, turn off Notifications in Repositories → Settings. Its automation keeps running.',
    ],
    links: [
      { label: 'Inbox and notifications', href: `${DOCS}/features/inbox` },
      { label: 'Web push setup', href: `${DOCS}/operations/pwa-web-push` },
    ],
  },
};
