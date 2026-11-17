import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';
export const RUNTIME_PACKAGES_DOCS = 'https://docs.propr.dev/docs/features/propr-cli#agent-runtime-packages';

/** Why runtime packages exist, shown as the section description. */
export const AgentRuntimePackagesDescription: React.FC = () => (
  <>
    Agents run without sudo, so add the Debian system tools they need here, such as{' '}
    <code className="text-[11px]">ffmpeg</code>. ProPR rebuilds the agent images with them.{' '}
    <a href={RUNTIME_PACKAGES_DOCS} target="_blank" rel="noopener noreferrer" className={LINK}>
      Runtime packages docs
    </a>
  </>
);

/** How to find the Debian name of a package, shown under the package field. */
export const AgentRuntimePackageNameHelp: React.FC = () => (
  <p className="mt-2 text-[12px] leading-5 text-slate-500">
    Use the Debian <code className="text-[11px]">apt</code> name, which can differ from the command:{' '}
    <code className="text-[11px]">psql</code> comes from <code className="text-[11px]">postgresql-client</code>.{' '}
    <a href="https://docs.propr.dev/docs/features/propr-cli#finding-package-names" target="_blank" rel="noopener noreferrer" className={LINK}>Finding package names</a>
  </p>
);
