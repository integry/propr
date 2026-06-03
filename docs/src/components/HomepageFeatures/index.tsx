import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Web UI Control Plane',
    description: (
      <>
        Configure monitored repositories, branches, processing labels, agent
        defaults, and live task operations from the browser instead of
        stitching together environment variables and logs for day-to-day work.
      </>
    ),
  },
  {
    title: 'Planner Studio',
    description: (
      <>
        Use the Web UI to build implementation plans, attach context, refine
        tasks, and approve execution before ProPR opens the branches, runs the
        work, and tracks progress live.
      </>
    ),
  },
  {
    title: 'Multi-Agent PR Automation',
    description: (
      <>
        Run repository work through supported coding agents, then
        refine pull requests with slash commands and the Ultrafix loop when a
        human wants follow-up help inside GitHub.
      </>
    ),
  },
];

function Feature({title, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
