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
    title: 'AI-Powered Resolution',
    description: (
      <>
        GitFix uses Claude AI to automatically analyze and resolve GitHub issues,
        providing intelligent solutions to your repository's problems.
      </>
    ),
  },
  {
    title: 'Automated Workflows',
    description: (
      <>
        Seamlessly integrates with GitHub to monitor issues, create branches,
        and submit pull requests automatically.
      </>
    ),
  },
  {
    title: 'Scalable Architecture',
    description: (
      <>
        Built with Docker, Redis, and PostgreSQL for reliable, distributed
        processing of multiple repositories and tasks.
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
