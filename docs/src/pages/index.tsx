import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';

import styles from './index.module.css';

const QUICKSTART_SNIPPET = `npm install -g @propr/cli   # Node.js 22+; prefix with sudo only if your global npm prefix requires it

mkdir propr && cd propr
propr init stack    # scaffold .env + data/ logs/ repos/, detect agent credentials
propr check         # verify Docker, images, agents, and GitHub auth
propr start         # pull images and start the stack with a live dashboard
propr ui            # open the Web UI`;

type IconName =
  | 'rocket'
  | 'play'
  | 'slash'
  | 'cpu'
  | 'terminal'
  | 'server'
  | 'activity'
  | 'layers'
  | 'book';

function Icon({name}: {name: IconName}) {
  const paths: Record<IconName, ReactNode> = {
    rocket: (
      <>
        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
        <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
        <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
      </>
    ),
    play: (
      <>
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" />
      </>
    ),
    slash: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="m14 7-4 10" />
      </>
    ),
    cpu: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
      </>
    ),
    terminal: (
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>
    ),
    server: (
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </>
    ),
    activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    layers: (
      <>
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </>
    ),
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>
    ),
  };
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

type SectionCard = {
  title: string;
  description: string;
  to: string;
  icon: IconName;
  accent: 'teal' | 'gold' | 'blue' | 'green';
  links: {label: string; to: string}[];
};

const SECTIONS: SectionCard[] = [
  {
    title: 'Set Up ProPR',
    description: 'GitHub App, agent credentials, and the one-command launcher.',
    to: '/docs/tutorials/setup',
    icon: 'rocket',
    accent: 'teal',
    links: [
      {label: 'Local setup', to: '/docs/tutorials/setup-local'},
      {label: 'Server setup (TLS, webhooks)', to: '/docs/tutorials/setup-server'},
      {label: 'From source', to: '/docs/tutorials/setup-source'},
    ],
  },
  {
    title: 'Run Your First Task',
    description: 'From a labeled issue or a Planner Studio draft to a reviewed pull request.',
    to: '/docs/tutorials/end-to-end-workflow',
    icon: 'play',
    accent: 'green',
    links: [
      {label: 'Daily use', to: '/docs/tutorials/usage'},
      {label: 'Planner Studio', to: '/docs/tutorials/planner-studio'},
      {label: 'Issue labels and routing', to: '/docs/features/agent-routing'},
    ],
  },
  {
    title: 'PR Commands',
    description: 'Drive follow-up work from the pull request conversation.',
    to: '/docs/features/pr-commands',
    icon: 'slash',
    accent: 'blue',
    links: [
      {label: '/review and /fix', to: '/docs/features/pr-review-fix-commands'},
      {label: '/ultrafix and /merge', to: '/docs/features/pr-ultrafix-commands'},
      {label: '/switch and /use', to: '/docs/features/pr-model-routing-commands'},
    ],
  },
  {
    title: 'Agents and Models',
    description: 'Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe with the full model catalog.',
    to: '/docs/features/agents-and-models',
    icon: 'cpu',
    accent: 'gold',
    links: [
      {label: 'Model labels (llm-*)', to: '/docs/features/agents-and-models#model-labels'},
      {label: 'Agent routing', to: '/docs/features/agent-routing'},
      {label: 'Execution safety', to: '/docs/features/execution-safety'},
    ],
  },
  {
    title: 'ProPR CLI',
    description: 'Plans, tasks, repositories, agents, and to-dos from the terminal.',
    to: '/docs/features/propr-cli',
    icon: 'terminal',
    accent: 'blue',
    links: [
      {label: 'Install and authenticate', to: '/docs/features/propr-cli#installation'},
      {label: 'Plan to PR from the shell', to: '/docs/features/propr-cli#scripting'},
    ],
  },
  {
    title: 'Operate the Stack',
    description: 'Deployment, backups, updates, and troubleshooting.',
    to: '/docs/operations/deployment',
    icon: 'server',
    accent: 'teal',
    links: [
      {label: 'Self-hosting and images', to: '/docs/features/self-hosting'},
      {label: 'Maintenance', to: '/docs/operations/maintenance'},
      {label: 'Cost and LLM metrics', to: '/docs/operations/llm-metrics'},
    ],
  },
  {
    title: 'Observability',
    description: 'Task records, live logs, dashboards, and Agent Tank capacity tracking.',
    to: '/docs/features/observability',
    icon: 'activity',
    accent: 'green',
    links: [
      {label: 'System metrics', to: '/docs/operations/system-metrics'},
      {label: 'Metrics feedback loop', to: '/docs/operations/metrics-feedback-loop'},
    ],
  },
  {
    title: 'Architecture',
    description: 'How the daemon, workers, queue, git layer, and agent runtimes fit together.',
    to: '/docs/architecture/overview',
    icon: 'layers',
    accent: 'gold',
    links: [
      {label: 'Daemon and intake', to: '/docs/architecture/daemon'},
      {label: 'Coding agent integration', to: '/docs/architecture/coding-agent-integration'},
      {label: 'Agent runtime', to: '/docs/architecture/agent-runtime'},
      {label: 'Git management', to: '/docs/architecture/git-management'},
    ],
  },
];

function HomepageHeader() {
  const logo = useBaseUrl('/img/logo-and-name-transparent.png');
  return (
    <header className={styles.heroBanner}>
      <div className="container">
        <img className={styles.heroLogo} src={logo} alt="ProPR" />
        <Heading as="h1" className={styles.heroTitle}>
          Documentation
        </Heading>
        <p className={styles.heroSubtitle}>
          Self-hosted, open-source platform that turns GitHub issues and plans into
          agent-implemented, reviewable pull requests — with planning, isolated execution,
          PR commands, and full task records.
        </p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/tutorials/setup">
            <Icon name="rocket" /> Set Up ProPR
          </Link>
          <Link className="button button--outline button--primary button--lg" to="/docs/tutorials/usage">
            <Icon name="book" /> Daily Use
          </Link>
          <Link className="button button--outline button--primary button--lg" to="/docs/features/propr-cli">
            <Icon name="terminal" /> CLI Reference
          </Link>
        </div>
      </div>
    </header>
  );
}

function Quickstart() {
  return (
    <section className={styles.quickstart}>
      <div className="container">
        <div className="row">
          <div className="col col--5">
            <Heading as="h2">Quickstart</Heading>
            <p>
              The ProPR CLI is the stack control plane: it scaffolds the runtime
              directory, verifies the host, and starts the prebuilt images on a
              Docker-capable Linux host. Configure{' '}
              <Link to="/docs/operations/github-auth">GitHub access</Link> (your own
              GitHub App, or a shared App that <code>propr setup</code> enrolls for
              you) and authenticate at least one agent CLI on the host.
            </p>
            <p>
              Full walkthroughs: <Link to="/docs/tutorials/setup-local">local</Link>,{' '}
              <Link to="/docs/tutorials/setup-server">server</Link>, or{' '}
              <Link to="/docs/tutorials/setup-source">from source</Link> — including a{' '}
              <Link to="/docs/tutorials/setup-local#alternative-launcher-container-without-the-cli">
                launcher-container path
              </Link>{' '}
              that needs no Node.js.
            </p>
          </div>
          <div className="col col--7">
            <CodeBlock language="bash">{QUICKSTART_SNIPPET}</CodeBlock>
            <p className={styles.quickstartNote}>
              Global install failing or needing <code>sudo</code> on a system
              Node? See{' '}
              <Link to="/docs/tutorials/setup-local">Local Setup</Link> for
              install-prefix notes.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionGrid() {
  return (
    <section className={styles.sections}>
      <div className="container">
        <div className="row">
          {SECTIONS.map((section) => (
            <div key={section.title} className={clsx('col col--3', styles.sectionCol)}>
              <div className={clsx(styles.sectionCard, styles[`accent-${section.accent}`])}>
                <div className={styles.sectionIcon}>
                  <Icon name={section.icon} />
                </div>
                <Heading as="h3">
                  <Link to={section.to}>{section.title}</Link>
                </Heading>
                <p>{section.description}</p>
                <ul>
                  {section.links.map((link) => (
                    <li key={link.to}>
                      <Link to={link.to}>{link.label}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} Documentation`}
      description="Set up ProPR, run issue-to-PR workflows with AI coding agents, drive follow-ups with PR commands, and operate the self-hosted stack.">
      <HomepageHeader />
      <main>
        <Quickstart />
        <SectionGrid />
      </main>
    </Layout>
  );
}
