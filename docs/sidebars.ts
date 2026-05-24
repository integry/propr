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
      label: 'Concepts',
      items: ['concepts/pr-review-guidelines'],
    },
    {
      type: 'category',
      label: 'Features',
      items: [
        'features/overview',
        'features/pr-commands',
        'features/branch-config',
      ],
    },
    {
      type: 'category',
      label: 'Tutorials',
      items: ['tutorials/setup', 'tutorials/usage'],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/daemon',
        'architecture/worker',
        'architecture/claude-integration',
        'architecture/git-management',
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      items: [
        'operations/deployment',
        'operations/system-metrics',
        'operations/llm-metrics',
        'operations/web-ui-integration',
      ],
    },
  ],
};

export default sidebars;
