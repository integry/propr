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
    'features',
    {
      type: 'category',
      label: 'Getting Started',
      items: ['getting-started/setup', 'getting-started/usage'],
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
      label: 'Technical Docs',
      items: [
        'AI_PR_REVIEW_GUIDELINES',
        'LLM_METRICS',
        'PRODUCTION_DEPLOYMENT',
        'REPOSITORY_BRANCH_CONFIG',
        'SYSTEM_METRICS',
        'WEB_UI_INTEGRATION',
      ],
    },
  ],
};

export default sidebars;
