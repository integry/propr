import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';

import styles from './index.module.css';

const LAUNCHER_SNIPPET = `docker run --rm \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$PWD/.env:/app/.env:ro" \\
  -v "$PWD/your-app-private-key.pem:/app/config/your-app-private-key.pem:ro" \\
  -e PROPR_ENV_FILE="$PWD/.env" \\
  -e PROPR_DATA_DIR="$PWD/data" \\
  -e PROPR_LOGS_DIR="$PWD/logs" \\
  -e PROPR_REPOS_DIR="$PWD/repos" \\
  -e HOST_CLAUDE_DIR="$HOME/.claude" \\
  propr/launcher:latest`;

type SectionCard = {
  title: string;
  description: string;
  to: string;
  links: {label: string; to: string}[];
};

const SECTIONS: SectionCard[] = [
  {
    title: 'Set Up ProPR',
    description: 'GitHub App, agent credentials, and the one-command launcher.',
    to: '/docs/tutorials/setup',
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
    links: [
      {label: 'Install and authenticate', to: '/docs/features/propr-cli#installation'},
      {label: 'Plan to PR from the shell', to: '/docs/features/propr-cli#scripting'},
    ],
  },
  {
    title: 'Operate the Stack',
    description: 'Deployment, backups, updates, and troubleshooting.',
    to: '/docs/operations/deployment',
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
    links: [
      {label: 'System metrics', to: '/docs/operations/system-metrics'},
      {label: 'Metrics feedback loop', to: '/docs/operations/metrics-feedback-loop'},
    ],
  },
  {
    title: 'Architecture',
    description: 'How the daemon, workers, queue, git layer, and agent runtimes fit together.',
    to: '/docs/architecture/overview',
    links: [
      {label: 'Daemon and intake', to: '/docs/architecture/daemon'},
      {label: 'Worker runtime', to: '/docs/architecture/worker-runtime'},
      {label: 'Git management', to: '/docs/architecture/git-management'},
    ],
  },
];

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title} Documentation
        </Heading>
        <p className="hero__subtitle">
          Self-hosted, open-source platform that turns GitHub issues and plans into
          agent-implemented, reviewable pull requests — with planning, isolated execution,
          PR commands, and full task records.
        </p>
        <div className={styles.buttons}>
          <Link className="button button--secondary button--lg" to="/docs/tutorials/setup">
            Set Up ProPR
          </Link>
          <Link className="button button--outline button--secondary button--lg" to="/docs/tutorials/usage">
            Daily Use
          </Link>
          <Link className="button button--outline button--secondary button--lg" to="/docs/features/propr-cli">
            CLI Reference
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
              ProPR runs from prebuilt images with a single launcher command on a
              Docker-capable Linux host. Create a runtime directory with your{' '}
              <Link to="/docs/tutorials/setup">GitHub App credentials and .env</Link>,
              authenticate at least one agent CLI on the host, then start the stack and
              open the Web UI at <code>http://localhost:5173</code>.
            </p>
            <p>
              Full walkthroughs: <Link to="/docs/tutorials/setup-local">local</Link>,{' '}
              <Link to="/docs/tutorials/setup-server">server</Link>, or{' '}
              <Link to="/docs/tutorials/setup-source">from source</Link>.
            </p>
          </div>
          <div className="col col--7">
            <CodeBlock language="bash">{LAUNCHER_SNIPPET}</CodeBlock>
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
              <div className={styles.sectionCard}>
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
