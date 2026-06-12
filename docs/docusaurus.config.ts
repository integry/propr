import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const legacyDocsRedirects = [
  {
    to: '/docs/concepts/pr-review-guidelines',
    from: '/docs/AI_PR_REVIEW_GUIDELINES',
  },
  {
    to: '/docs/operations/llm-metrics',
    from: '/docs/LLM_METRICS',
  },
  {
    to: '/docs/operations/deployment',
    from: '/docs/PRODUCTION_DEPLOYMENT',
  },
  {
    to: '/docs/features/branch-config',
    from: '/docs/REPOSITORY_BRANCH_CONFIG',
  },
  {
    to: '/docs/operations/system-metrics',
    from: '/docs/SYSTEM_METRICS',
  },
  {
    to: '/docs/operations/web-ui-integration',
    from: '/docs/WEB_UI_INTEGRATION',
  },
  {
    to: '/docs/features/overview',
    from: '/docs/features',
  },
  {
    to: '/docs/tutorials/setup',
    from: '/docs/getting-started/setup',
  },
  {
    to: '/docs/tutorials/usage',
    from: '/docs/getting-started/usage',
  },
  {
    to: '/docs/features/pr-commands',
    from: '/docs/pr-commands',
  },
] as const;

const config: Config = {
  title: 'ProPR',
  tagline: 'Web UI for AI planning, execution, and PR automation',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://docs.propr.dev',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'integry', // Usually your GitHub org/user name.
  projectName: 'gitfix', // Usually your repo name.

  onBrokenLinks: 'throw',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/integry/propr/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: legacyDocsRedirects,
      },
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/social-card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      logo: {
        alt: 'ProPR',
        src: 'img/logo-and-name-transparent.png',
        href: 'https://propr.dev',
        target: '_self',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          href: 'https://propr.dev',
          label: 'propr.dev',
          position: 'right',
          target: '_self',
        },
        {
          href: 'https://demo.propr.dev',
          label: 'Live Demo',
          position: 'right',
        },
        {
          href: 'https://github.com/integry/propr',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Introduction',
              to: '/docs/intro',
            },
            {
              label: 'Setup',
              to: '/docs/tutorials/setup',
            },
            {
              label: 'ProPR CLI',
              to: '/docs/features/propr-cli',
            },
          ],
        },
        {
          title: 'Product',
          items: [
            {
              label: 'propr.dev',
              href: 'https://propr.dev',
            },
            {
              label: 'Live Demo',
              href: 'https://demo.propr.dev',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/integry/propr',
            },
            {
              label: 'Discord',
              href: 'https://discord.gg/wNYzTwZFku',
            },
            {
              label: 'Reddit',
              href: 'https://www.reddit.com/r/ProPRdev/',
            },
          ],
        },
      ],
      copyright: `Copyright (c) ${new Date().getFullYear()} ProPR by Unchained Development O\u00dc / Rinalds Uzkalns`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
