import React from 'react';

const LINK = 'font-medium text-primary-600 underline hover:text-primary-700';

/** Why runtime packages exist, shown as the section description. */
export const AgentRuntimePackagesDescription: React.FC = () => (
  <>
    Agents run in a Debian container with Git, Node.js, Python and the agent CLIs, but without sudo, so they cannot{' '}
    <code className="text-[11px]">apt-get install</code> anything during a task. Add system tools your builds, tests or
    previews need here, such as <code className="text-[11px]">ffmpeg</code>, <code className="text-[11px]">imagemagick</code>{' '}
    or <code className="text-[11px]">postgresql-client</code>. ProPR rebuilds every agent image with them and keeps the
    previous images until the rebuild succeeds. Project dependencies from npm or pip belong in{' '}
    <code className="text-[11px]">.propr/setup.sh</code> instead.{' '}
    <a
      href="https://docs.propr.dev/docs/features/propr-cli#agent-runtime-packages"
      target="_blank"
      rel="noopener noreferrer"
      className={LINK}
    >
      Runtime packages docs
    </a>
  </>
);

/** How to find the Debian name of a package, shown under the package field. */
export const AgentRuntimePackageNameHelp: React.FC = () => (
  <div className="mt-2 text-[12px] leading-5 text-slate-500">
    <p className="font-medium text-slate-700">Finding package names</p>
    <ul className="mt-1 list-disc space-y-0.5 pl-4">
      <li>
        Use the Debian <code className="text-[11px]">apt</code> package name, which can differ from the command name:
        the <code className="text-[11px]">psql</code> command comes from{' '}
        <code className="text-[11px]">postgresql-client</code>.
      </li>
      <li>Type at least two characters to search the catalog of the agent images. Only packages available to every image are listed.</li>
      <li>
        Not sure what provides a command or file? Search{' '}
        <a href="https://packages.debian.org/" target="_blank" rel="noopener noreferrer" className={LINK}>
          packages.debian.org
        </a>{' '}
        for the Debian release of the agent images, which appears under the field after a search. Its contents search finds the package that installs a given file.
      </li>
      <li>
        Pin a version with <code className="text-[11px]">name=version</code> or choose an architecture with{' '}
        <code className="text-[11px]">name:arch</code>.
      </li>
    </ul>
  </div>
);
