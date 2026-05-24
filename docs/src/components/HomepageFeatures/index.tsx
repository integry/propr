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
    title: 'Multi-Agent Execution',
    description: (
      <>
        Run repository work through Claude, Codex, and Gemini agents with
        model-aware routing, isolated execution, and PR workflows that can
        switch reviewers or implementers as needed.
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
    title: 'Ultrafix Loop',
    description: (
      <>
        Automate review-fix cycles on pull requests with configurable score
        goals, CI gating, cooldown windows, and a simple label-based circuit
        breaker for human control.
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
