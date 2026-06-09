import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Setup',
      items: [
        'tutorials/setup',
        'tutorials/setup-local',
        'tutorials/setup-server',
        'tutorials/setup-source',
      ],
    },
    {
      type: 'category',
      label: 'Tutorials',
      items: [
        'tutorials/usage',
        'tutorials/end-to-end-workflow',
        'tutorials/planner-studio',
      ],
    },
    {
      type: 'doc',
      id: 'features/overview',
      label: 'Feature Overview',
    },
    {
      type: 'category',
      label: 'Core Workflow',
      items: [
        'features/planning',
        'features/agent-routing',
        'features/execution-safety',
        'features/observability',
        'features/self-hosting',
      ],
    },
    {
      type: 'category',
      label: 'PR Control',
      items: [
        'features/pr-followup',
        'features/pr-commands',
        'features/pr-review-fix-commands',
        'features/pr-model-routing-commands',
        'features/pr-ultrafix-commands',
      ],
    },
    {
      type: 'category',
      label: 'Repository Context',
      items: [
        'features/repository-knowledge',
        'features/work-splitting',
        'features/branch-config',
      ],
    },
    {
      type: 'category',
      label: 'Tools',
      items: [
        'features/cli-workflows',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      items: ['concepts/pr-review-guidelines'],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/daemon',
        'architecture/daemon-runtime',
        'architecture/worker',
        'architecture/worker-runtime',
        'architecture/claude-integration',
        'architecture/opencode-integration',
        'architecture/claude-code-runtime',
        'architecture/git-management',
        'architecture/git-runtime',
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      items: [
        'operations/deployment',
        'operations/github-auth',
        'operations/maintenance',
        'operations/system-metrics',
        'operations/metrics-feedback-loop',
        'operations/llm-metrics',
        'operations/web-ui-integration',
      ],
    },
  ],
};

export default sidebars;
