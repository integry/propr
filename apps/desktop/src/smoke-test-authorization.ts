import { basename, isAbsolute, resolve } from 'node:path';

export const PACKAGED_SMOKE_USER_DATA_PREFIX = 'propr-desktop-smoke-';
const PACKAGED_SMOKE_USER_DATA_LEAF = /^propr-desktop-smoke-[A-Za-z0-9]+$/;

const samePath = (left: string, right: string, platform: NodeJS.Platform): boolean => {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
};

const explicitUserDataDirectory = (argv: readonly string[]): string => {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--user-data-dir') {
      values.push(argv[index + 1] ?? '');
      index += 1;
    } else if (argument.startsWith('--user-data-dir=')) {
      values.push(argument.slice('--user-data-dir='.length));
    }
  }
  if (values.length !== 1 || !values[0]) {
    throw new Error('Packaged desktop smoke requires exactly one explicit --user-data-dir');
  }
  return values[0];
};

export const authorizePackagedSmokeTest = ({
  argv,
  defaultUserDataDirectory,
  environmentTriggered,
  isPackaged,
  platform,
}: {
  argv: readonly string[];
  defaultUserDataDirectory: string;
  environmentTriggered: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): string | null => {
  const argumentTriggered = argv.includes('--propr-smoke-test');
  if (!isPackaged || !argumentTriggered || !environmentTriggered) return null;

  const requested = explicitUserDataDirectory(argv);
  if (!isAbsolute(requested) || /[\0\r\n]/.test(requested)) {
    throw new Error('Packaged desktop smoke --user-data-dir must be absolute');
  }
  if (samePath(requested, defaultUserDataDirectory, platform)) {
    throw new Error('Packaged desktop smoke cannot use the default profile store');
  }
  if (!PACKAGED_SMOKE_USER_DATA_LEAF.test(basename(requested))) {
    throw new Error(`Packaged desktop smoke --user-data-dir must use ${PACKAGED_SMOKE_USER_DATA_PREFIX}`);
  }
  return resolve(requested);
};
