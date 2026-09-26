import type { MakerOptions } from '@electron-forge/maker-base';
import {
  MakerRpm,
  rpmArch,
} from '@electron-forge/maker-rpm';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type RedhatInstallerInstance = {
  options: {
    packagePaths?: string[];
    logger: (message: string) => void;
  };
  specPath: string;
  generateDefaults(): Promise<void>;
  generateOptions(): void;
  generateScripts(): Promise<void>;
  createStagingDir(): Promise<void>;
  createContents(): Promise<void>;
  createPackage(): Promise<void>;
  movePackage(): Promise<void>;
  createSpec(): Promise<void>;
  createTemplatedFile(source: string, destination: string): Promise<void>;
};

type RedhatInstallerConstructor = new (options: Record<string, unknown>) => RedhatInstallerInstance;
type RedhatInstallerModule = {
  Installer: RedhatInstallerConstructor;
};

const renameRpm = (destination: string) => join(
  destination,
  '<%= name %>-<%= version %>-<%= revision %>.<%= arch === "aarch64" ? "arm64" : arch %>.rpm',
);
const RPM_SPEC_TEMPLATE = fileURLToPath(new URL('../assets/linux/rpm.spec.ejs', import.meta.url));

/**
 * MakerRpm with a ProPR-owned spec template. electron-installer-redhat 3.x
 * stages chrome-sandbox as 4755, but its plain `cp -r` install step clears the
 * setuid bit before rpmbuild records the payload metadata.
 */
export class ProprMakerRpm extends MakerRpm {
  readonly specTemplate = RPM_SPEC_TEMPLATE;

  override async make({ dir, makeDir, targetArch }: MakerOptions): Promise<string[]> {
    const outDir = resolve(makeDir, 'rpm', targetArch);
    await this.ensureDirectory(outDir);

    // Resolve the optional installer from MakerRpm's dependency tree so this
    // module remains importable on platforms where RPM support is not installed.
    const localRequire = createRequire(import.meta.url);
    const makerEntry = localRequire.resolve('@electron-forge/maker-rpm');
    const makerRequire = createRequire(join(dirname(makerEntry), 'maker-rpm-loader.cjs'));
    const redhatInstaller = makerRequire('electron-installer-redhat') as RedhatInstallerModule;
    const specTemplate = this.specTemplate;

    class ProprRedhatInstaller extends redhatInstaller.Installer {
      override async createSpec(): Promise<void> {
        this.options.logger(`Creating ProPR RPM spec file at ${this.specPath}`);
        await this.createTemplatedFile(specTemplate, this.specPath);
      }
    }

    const installer = new ProprRedhatInstaller({
      ...this.config,
      arch: rpmArch(targetArch),
      src: dir,
      dest: outDir,
      rename: renameRpm,
      logger: () => undefined,
    });
    await installer.generateDefaults();
    installer.generateOptions();
    await installer.generateScripts();
    await installer.createStagingDir();
    await installer.createContents();
    await installer.createPackage();
    await installer.movePackage();

    if (!installer.options.packagePaths || installer.options.packagePaths.length === 0) {
      throw new Error('RPM maker did not produce an artifact');
    }
    return installer.options.packagePaths;
  }
}
