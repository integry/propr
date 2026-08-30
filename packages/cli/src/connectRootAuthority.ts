import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireInstalledWindowsLaunchLease,
  WindowsInstalledAuthorityError,
  type InstalledWindowsLaunchLease,
} from "./windowsInstalledAuthority.js";

const NATIVE_INSPECTION_MAX_BYTES = 128 * 1024;
const WINDOWS_SID = /^S-\d(?:-\d+)+$/;
const WINDOWS_TRUSTED_MUTATORS = new Set([
  "S-1-5-18", // NT AUTHORITY\\SYSTEM
  "S-1-5-32-544", // BUILTIN\\Administrators
]);

// FileSystemRights values which can alter an entry, its children, or its ACL.
const WINDOWS_MUTATING_RIGHTS = BigInt(
  0x00000002 // WriteData / CreateFiles
  | 0x00000004 // AppendData / CreateDirectories
  | 0x00000010 // WriteExtendedAttributes
  | 0x00000040 // DeleteSubdirectoriesAndFiles
  | 0x00000100 // WriteAttributes
  | 0x00010000 // Delete
  | 0x00040000 // ChangePermissions
  | 0x00080000 // TakeOwnership
);
const WINDOWS_GENERIC_MUTATING_RIGHTS = 0x50000000n; // GENERIC_WRITE | GENERIC_ALL
const WINDOWS_KNOWN_ALLOW_RIGHTS = 0xf01f01ffn;

export type ConnectAuthorityEntryKind = "ancestor" | "home" | "root" | "data" | "env";

export interface WindowsAclRuleInspection {
  readonly identitySid: string;
  readonly inherited: boolean;
  readonly accessType: "allow" | "deny";
  readonly appliesToSelf: boolean;
  /** Canonical base-10 representation of the unsigned 32-bit access mask. */
  readonly rights: string;
}

export interface WindowsAuthorityInspection {
  readonly index: number;
  readonly kind: "directory" | "file";
  readonly authorityKind: ConnectAuthorityEntryKind;
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly reparsePoint: boolean;
  readonly volumeSerialNumber: string;
  /** Full unsigned 128-bit FILE_ID_128 as a canonical decimal string. */
  readonly fileId: string;
  /** A second read from the same held handle after ACL inspection. */
  readonly verifiedVolumeSerialNumber: string;
  readonly verifiedFileId: string;
  readonly rules: readonly WindowsAclRuleInspection[];
}

export interface DarwinAuthorityInspection {
  readonly version: 1;
  readonly device: string;
  readonly file: string;
  readonly acl: string;
}

export interface StableAuthorityIdentity {
  readonly device: string;
  readonly file: string;
}

export type WindowsAuthorityPolicyReason =
  | "OWNER_MISMATCH"
  | "DACL_NOT_PROTECTED"
  | "REPARSE_POINT"
  | "UNKNOWN_RIGHTS"
  | "BROAD_WRITE"
  | "INHERITED_WRITE";

/** Redacted native diagnostic: an entry ordinal and fixed policy reason only. */
export class WindowsAuthorityPolicyError extends Error {
  constructor(
    readonly entryIndex: number,
    readonly policyReason: WindowsAuthorityPolicyReason,
  ) {
    super(`Windows native authority rejected entry ${entryIndex}: ${policyReason}`);
    this.name = "WindowsAuthorityPolicyError";
  }
}

export interface ConnectRootAuthorityInspector {
  inspectDarwinAcl(
    path: string,
    pinnedFd: number,
    expectedIdentity: StableAuthorityIdentity,
  ): DarwinAuthorityInspection;
  inspectWindowsAcl(
    path: string,
    expectedIdentity: StableAuthorityIdentity,
    pinnedFd?: number,
    kind?: ConnectAuthorityEntryKind,
  ): Promise<WindowsAuthorityInspection>;
  inspectWindowsAcls?(entries: readonly WindowsAuthorityTarget[]): Promise<readonly WindowsAuthorityInspection[]>;
}

export interface WindowsAuthorityTarget {
  readonly path: string;
  readonly kind: ConnectAuthorityEntryKind;
  readonly expectedIdentity: StableAuthorityIdentity;
  readonly pinnedFd: number;
}

export function stableAuthorityIdentity(fd: number): StableAuthorityIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { device: stat.dev.toString(10), file: stat.ino.toString(10) };
}

function decodeBoundedUtf8(value: Buffer | string | null | undefined): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : (value ?? Buffer.alloc(0));
  if (bytes.byteLength > NATIVE_INSPECTION_MAX_BYTES) throw new Error("native authority inspection exceeded its limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const DARWIN_AUTHORITY_BROKER_SHA256: Readonly<Record<string, string>> = {
  arm64: "75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0",
  x64: "e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b",
};

const WINDOWS_AUTHORITY_BROKER_SHA256: Readonly<Record<string, string>> = {
  x64: "2ba903761156ef39235347998201710335ebe4fc97e51420ed1d117d384ce1d7",
};
const WINDOWS_AUTHORITY_BOOTSTRAP_SHA256 = "2373622afcd21231ff5bd2953f5896af1eb8565bbe395eeb5128b0591145ea17";
const WINDOWS_AUTHORITY_BOOTSTRAP_SOURCE_SHA256 = "9c78ab7d06b43dcee72420ec6442fc639b5542a8ef76be3a46d281843d43ef72";

const WINDOWS_AUTHORITY_PROTOCOL_VERSION = 2;
const WINDOWS_AUTHORITY_SUPERVISOR_SOURCE_SHA256 = "68b38a53d073b032e9ed0c1f5e9c8a69c306b399524b654a691e3eb13d271aff";
const WINDOWS_AUTHORITY_SERVICE_SOURCE_SHA256 = "4b30b4374ad85433f6ff4b065bf9df013ec5393ecd2f49b74ac6eabe9901499c";
const WINDOWS_AUTHORITY_SERVICE_INSTALLER_SOURCE_SHA256 = "3f3d7034b47bbf1ad7100cdb5ce4bce9360e6479669629a5452c23b4eefc77e6";
const WINDOWS_AUTHORITY_LAUNCHER_SOURCE_SHA256 = "f5b29a4b2f8fbcce41690e2363d90440d73fbebb10114ec0eae53e9653f34a4c";
type WindowsBuildToolchainProfile = "vs2026-18.9-x64" | "vs2026-18.9-arm64" | "vs2022-17.14-x64";
const WINDOWS_AUTHORITY_BUILD_TOOL_SIGNERS = Object.freeze({
  "vs2026-18.9-x64": Object.freeze({
    compiler: Object.freeze({ leaf: "b89f8f6bf4f50250528995fd16e228f1b24ee0017d8f87b0c756c1b85b82f58c", spki: "c36d219b65bcb11b4c7766f5e4707aac8e7f391fb57d9be21b31ff06c0c27d8a" }),
    "native-compiler": Object.freeze({ leaf: "c30b441672c82883d92eddac6d24cb57e9960bda4486c7fb5865e74157f35850", spki: "72bc03497a5c3fd67db74a5c648239fa9d212ff61a64250d28e475d688d49b97" }),
    "native-linker": Object.freeze({ leaf: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed", spki: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d" }),
  }),
  "vs2026-18.9-arm64": Object.freeze({
    compiler: Object.freeze({ leaf: "35e68cd82f647085ef7da13ce37929fa2d298fae6cb1d41c66a00709d00c8eae", spki: "8598bc6053649a189e5ad15335f52fee71486e11f8e0f9947ae05814871e4560" }),
    "native-compiler": Object.freeze({ leaf: "c30b441672c82883d92eddac6d24cb57e9960bda4486c7fb5865e74157f35850", spki: "72bc03497a5c3fd67db74a5c648239fa9d212ff61a64250d28e475d688d49b97" }),
    "native-linker": Object.freeze({ leaf: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed", spki: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d" }),
  }),
  "vs2022-17.14-x64": Object.freeze({
    compiler: Object.freeze({ leaf: "35e68cd82f647085ef7da13ce37929fa2d298fae6cb1d41c66a00709d00c8eae", spki: "8598bc6053649a189e5ad15335f52fee71486e11f8e0f9947ae05814871e4560" }),
    "native-compiler": Object.freeze({ leaf: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed", spki: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d" }),
    "native-linker": Object.freeze({ leaf: "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed", spki: "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d" }),
  }),
});
const WINDOWS_AUTHORITY_BUILD_TOOL_DEPENDENCIES = Object.freeze({
  "vs2026-18.9-x64": Object.freeze({
    "roslyn-runtime": Object.freeze({ sha256: "d4630911fcc8edd9ea0581c2d905270790b0f3de2b212d4f8a9a8b2164d016e5", files: 111, bytes: "35634755" }),
    "msvc-host-runtime": Object.freeze({ sha256: "779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13", files: 84, bytes: "126253430" }),
  }),
  "vs2026-18.9-arm64": Object.freeze({
    "roslyn-runtime": Object.freeze({ sha256: "65c926bb608189705239c90f011b52a1f493d569d00027468cdb5961aa21d026", files: 111, bytes: "35633203" }),
    "msvc-host-runtime": Object.freeze({ sha256: "779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13", files: 84, bytes: "126253430" }),
  }),
  "vs2022-17.14-x64": Object.freeze({
    "roslyn-runtime": Object.freeze({ sha256: "72f9aafb187eb7db512466571374fc33d22d3120d1341c2bc6315c4e5e8b2209", files: 111, bytes: "38581501" }),
    "msvc-host-runtime": Object.freeze({ sha256: "b2e20ac87ae5c38d72a2c6c6d2dbcfb013978b9e0240717656cd14b2d7957ac2", files: 53, bytes: "62411793" }),
  }),
  "wix-runtime": Object.freeze({
    sha256: "732cdbb86eda6156f859cda583c0e1632e0c1a213aaabc6bee052e335549b298",
    files: 33,
    bytes: "31929694",
  }),
});
const WINDOWS_AUTHORITY_MANIFEST_PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABGK5YqTyhB9t0ItFKrMe9jiZ1two1naR/H1jqb6lRYU=
-----END PUBLIC KEY-----`);

const WINDOWS_CAPABILITY_STARTUP_TIMEOUT_MS = 10_000;
const WINDOWS_BROKER_BATCH_TIMEOUT_MS = 5_000;
const WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS = 2_500;
const WINDOWS_CAPABILITY_STOP_TIMEOUT_MS = 2_500;
const WINDOWS_BROKER_REQUEST_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_MAX_MESSAGES = 256;

export const WINDOWS_SUPERVISOR_STAGE_VALUES = [
  "BUILD_COMPILER", "BUILD_SOURCE", "BUILD_OUTPUT", "MANIFEST", "HELPER_OPEN",
  "HELPER_IDENTITY", "HELPER_HASH", "TRANSPORT_SPAWN", "JOB_ASSIGN", "PROTOCOL_INIT",
  "READY", "PRE_CHALLENGE", "BATCH_LAUNCH", "FD_DUPLICATE", "BATCH_RESPONSE",
  "POST_CHALLENGE", "SHUTDOWN",
] as const;
export type WindowsSupervisorStage = typeof WINDOWS_SUPERVISOR_STAGE_VALUES[number];
const WINDOWS_SUPERVISOR_STAGES = new Set<WindowsSupervisorStage>(WINDOWS_SUPERVISOR_STAGE_VALUES);
function authorityBrokerArtifact(platform: "darwin" | "win32", arch: string, expectedOverride?: string): {
  path: string;
  fd: number;
  identity: StableAuthorityIdentity;
  digest: string;
  bytes: Buffer;
} {
  const expected = expectedOverride ?? (platform === "darwin"
    ? DARWIN_AUTHORITY_BROKER_SHA256[arch]
    : WINDOWS_AUTHORITY_BROKER_SHA256[arch]);
  if (!expected) throw new Error(`native authority inspection is not packaged for ${platform}-${arch}`);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relative = join(
    "prebuilds",
    `${platform}-${arch}`,
    `connect-authority-broker${platform === "win32" ? ".exe" : ""}`,
  );
  const candidates = [
    join(moduleDirectory, "native", relative),
    join(moduleDirectory, "..", "native", relative),
    join(moduleDirectory, "..", "..", "native", relative),
  ];
  for (const candidate of candidates) {
    let fd: number | undefined;
    try {
      fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(candidate, { bigint: true });
      if (
        !stat.isFile()
        || named.isSymbolicLink()
        || stat.dev !== named.dev
        || stat.ino !== named.ino
        || stat.size <= 0n
        || stat.size > BigInt(512 * 1024)
        || (platform === "darwin" && (
          (typeof process.getuid === "function" && stat.uid !== 0n && stat.uid !== BigInt(process.getuid()))
          || (stat.mode & 0o022n) !== 0n
        ))
      ) {
        closeSync(fd);
        fd = undefined;
        continue;
      }
      const bytes = readExactDescriptor(fd, Number(stat.size));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected) throw new Error("packaged native authority broker failed integrity verification");
      return {
        path: candidate,
        fd,
        identity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
        digest,
        bytes,
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`packaged native authority broker is missing for ${platform}-${arch}`);
}

function windowsBootstrapArtifact(): ReturnType<typeof authorityBrokerArtifact> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relative = join("prebuilds", "win32-x64", "connect-authority-bootstrap.exe");
  const candidates = [
    join(moduleDirectory, "native", relative),
    join(moduleDirectory, "..", "native", relative),
    join(moduleDirectory, "..", "..", "native", relative),
  ];
  for (const path of candidates) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino
        || stat.nlink !== 1n || stat.size < 1024n || stat.size > BigInt(512 * 1024)) {
        throw new WindowsSupervisorStartupError("HELPER_IDENTITY");
      }
      const bytes = readExactDescriptor(fd, Number(stat.size));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== WINDOWS_AUTHORITY_BOOTSTRAP_SHA256) throw new WindowsSupervisorStartupError("HELPER_HASH");
      return {
        path,
        fd,
        identity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
        digest,
        bytes,
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new WindowsSupervisorStartupError("HELPER_OPEN");
}

function revalidateWindowsBootstrapArtifact(
  bootstrap: ReturnType<typeof windowsBootstrapArtifact>,
): void {
  let namedFd: number | undefined;
  try {
    namedFd = openSync(bootstrap.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(bootstrap.fd, { bigint: true });
    const named = fstatSync(namedFd, { bigint: true });
    const path = lstatSync(bootstrap.path, { bigint: true });
    if (!held.isFile() || !named.isFile() || path.isSymbolicLink()
      || held.dev !== named.dev || held.ino !== named.ino
      || named.dev !== path.dev || named.ino !== path.ino
      || named.nlink !== 1n || named.size !== BigInt(bootstrap.bytes.byteLength)) {
      throw new WindowsSupervisorStartupError("HELPER_IDENTITY");
    }
    const digest = createHash("sha256")
      .update(readExactDescriptor(namedFd, bootstrap.bytes.byteLength)).digest("hex");
    if (digest !== bootstrap.digest || digest !== WINDOWS_AUTHORITY_BOOTSTRAP_SHA256) {
      throw new WindowsSupervisorStartupError("HELPER_HASH");
    }
  } catch (error) {
    if (error instanceof WindowsSupervisorStartupError) throw error;
    throw new WindowsSupervisorStartupError((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "HELPER_OPEN" : "HELPER_IDENTITY");
  } finally {
    if (namedFd !== undefined) closeSync(namedFd);
  }
}

interface WindowsSupervisorManifest {
  readonly format: "propr-windows-authority-helper-v2";
  readonly protocolVersion: 2;
  readonly sourceSha256: string;
  readonly launcherSourceSha256: string;
  readonly helperSha256: string;
  readonly launcherSha256: string;
  readonly service: {
    readonly version: "3.0.0";
    readonly sourceSha256: string;
    readonly imageSha256: string;
    readonly installerSourceSha256: string;
    readonly installerSha256: string;
    readonly authenticodeLeafSha256: string | null;
    readonly authenticodeSpkiSha256: string | null;
  };
  readonly pe: { readonly architecture: "anycpu"; readonly managed: true; readonly deterministic: true };
  readonly build: {
    readonly toolchainProfile: WindowsBuildToolchainProfile;
    readonly compilerSha256: string;
    readonly launcherCompilerSha256: string;
    readonly launcherLinkerSha256: string;
    readonly bootstrapSourceSha256: string;
    readonly bootstrapSha256: string;
    readonly compilerRelativePath: string;
    readonly toolSigners: readonly {
      readonly name: "compiler" | "native-compiler" | "native-linker";
      readonly signatureKind: "E";
      readonly authenticodeLeafSha256: string;
      readonly authenticodeSpkiSha256: string;
    }[];
    readonly toolDependencies: readonly { readonly name: string; readonly sha256: string; readonly files: number; readonly bytes: string }[];
    readonly references: readonly { readonly name: string; readonly sha256: string }[];
    readonly nativeInputs: readonly { readonly name: string; readonly sha256: string; readonly files: number; readonly bytes: string }[];
  };
  readonly trust: {
    readonly mode: "unsigned-validation" | "production-signed";
    readonly authenticodeLeafSha256: string | null;
    readonly authenticodeSpkiSha256: string | null;
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactWindowsSupervisorManifest(value: unknown): value is WindowsSupervisorManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (!exactKeys(manifest, ["format", "protocolVersion", "sourceSha256", "launcherSourceSha256", "helperSha256", "launcherSha256", "service", "pe", "build", "trust"])) return false;
  const pe = manifest.pe as Record<string, unknown> | undefined;
  const build = manifest.build as Record<string, unknown> | undefined;
  const trust = manifest.trust as Record<string, unknown> | undefined;
  const service = manifest.service as Record<string, unknown> | undefined;
  const toolchainProfile = build?.toolchainProfile;
  const allowedToolchain = typeof toolchainProfile === "string"
    && Object.hasOwn(WINDOWS_AUTHORITY_BUILD_TOOL_SIGNERS, toolchainProfile);
  const dependencyPolicy = allowedToolchain
    ? WINDOWS_AUTHORITY_BUILD_TOOL_DEPENDENCIES[toolchainProfile as WindowsBuildToolchainProfile]
    : undefined;
  const signerPolicy = allowedToolchain
    ? WINDOWS_AUTHORITY_BUILD_TOOL_SIGNERS[toolchainProfile as WindowsBuildToolchainProfile]
    : undefined;
  if (!pe || Array.isArray(pe) || !exactKeys(pe, ["architecture", "managed", "deterministic"])
    || pe.architecture !== "anycpu" || pe.managed !== true || pe.deterministic !== true
    || !build || Array.isArray(build) || !exactKeys(build, ["toolchainProfile", "compilerSha256", "launcherCompilerSha256", "launcherLinkerSha256", "bootstrapSourceSha256", "bootstrapSha256", "compilerRelativePath", "toolSigners", "toolDependencies", "references", "nativeInputs"])
    || !allowedToolchain
    || build.compilerRelativePath !== (String(toolchainProfile).startsWith("vs2026-")
      ? "VisualStudio/18/MSBuild/Current/Bin/Roslyn/csc.exe"
      : "VisualStudio/2022/17.14/MSBuild/Current/Bin/Roslyn/csc.exe")
    || typeof build.compilerRelativePath !== "string" || build.compilerRelativePath.length < 1 || build.compilerRelativePath.length > 160
    || !/^[0-9a-f]{64}$/.test(String(build.compilerSha256))
    || !/^[0-9a-f]{64}$/.test(String(build.launcherCompilerSha256))
    || !/^[0-9a-f]{64}$/.test(String(build.launcherLinkerSha256))
    || build.bootstrapSourceSha256 !== WINDOWS_AUTHORITY_BOOTSTRAP_SOURCE_SHA256
    || build.bootstrapSha256 !== WINDOWS_AUTHORITY_BOOTSTRAP_SHA256
    || !Array.isArray(build.toolSigners) || build.toolSigners.length !== 3
    || build.toolSigners.map((item) => item && typeof item === "object" && !Array.isArray(item)
      && exactKeys(item as Record<string, unknown>, ["name", "signatureKind", "authenticodeLeafSha256", "authenticodeSpkiSha256"])
      && (item as Record<string, unknown>).name
      && (item as Record<string, unknown>).signatureKind === "E"
      && (item as Record<string, unknown>).authenticodeLeafSha256
        === signerPolicy?.[(item as { name: "compiler" | "native-compiler" | "native-linker" }).name]?.leaf
      && (item as Record<string, unknown>).authenticodeSpkiSha256
        === signerPolicy?.[(item as { name: "compiler" | "native-compiler" | "native-linker" }).name]?.spki)
      .join("\0") !== "compiler\0native-compiler\0native-linker"
    || !Array.isArray(build.toolDependencies) || build.toolDependencies.length !== 3
    || !build.toolDependencies.every((item) => item && typeof item === "object" && !Array.isArray(item)
      && exactKeys(item as Record<string, unknown>, ["name", "sha256", "files", "bytes"])
      && ["roslyn-runtime", "msvc-host-runtime", "wix-runtime"].includes(String((item as Record<string, unknown>).name))
      && /^[0-9a-f]{64}$/.test(String((item as Record<string, unknown>).sha256))
      && Number.isInteger((item as Record<string, unknown>).files)
      && Number((item as Record<string, unknown>).files) > 0
      && /^(?:0|[1-9]\d{0,12})$/.test(String((item as Record<string, unknown>).bytes))
      && (item as Record<string, unknown>).sha256
        === ((item as { name: string }).name === "wix-runtime" ? WINDOWS_AUTHORITY_BUILD_TOOL_DEPENDENCIES["wix-runtime"].sha256
          : dependencyPolicy?.[(item as { name: "roslyn-runtime" | "msvc-host-runtime" }).name]?.sha256)
      && (item as Record<string, unknown>).files
        === ((item as { name: string }).name === "wix-runtime" ? WINDOWS_AUTHORITY_BUILD_TOOL_DEPENDENCIES["wix-runtime"].files
          : dependencyPolicy?.[(item as { name: "roslyn-runtime" | "msvc-host-runtime" }).name]?.files)
      && (item as Record<string, unknown>).bytes
        === ((item as { name: string }).name === "wix-runtime" ? WINDOWS_AUTHORITY_BUILD_TOOL_DEPENDENCIES["wix-runtime"].bytes
          : dependencyPolicy?.[(item as { name: "roslyn-runtime" | "msvc-host-runtime" }).name]?.bytes))
    || build.toolDependencies.map((item) => (item as { name: string }).name).join("\0")
      !== "roslyn-runtime\0msvc-host-runtime\0wix-runtime"
    || !Array.isArray(build.references) || build.references.length < 1 || build.references.length > 16
    || !build.references.every((item) => item && typeof item === "object" && !Array.isArray(item)
      && exactKeys(item as Record<string, unknown>, ["name", "sha256"])
      && typeof (item as Record<string, unknown>).name === "string"
      && /^[0-9a-f]{64}$/.test(String((item as Record<string, unknown>).sha256)))
    || !Array.isArray(build.nativeInputs) || build.nativeInputs.length !== 7
    || !build.nativeInputs.every((item) => item && typeof item === "object" && !Array.isArray(item)
      && exactKeys(item as Record<string, unknown>, ["name", "sha256", "files", "bytes"])
      && typeof (item as Record<string, unknown>).name === "string"
      && /^[0-9a-f]{64}$/.test(String((item as Record<string, unknown>).sha256))
      && Number.isInteger((item as Record<string, unknown>).files)
      && Number((item as Record<string, unknown>).files) > 0
      && /^(?:0|[1-9]\d{0,12})$/.test(String((item as Record<string, unknown>).bytes)))
    || !service || Array.isArray(service) || !exactKeys(service, ["version", "sourceSha256", "imageSha256", "installerSourceSha256", "installerSha256", "authenticodeLeafSha256", "authenticodeSpkiSha256"])
    || service.version !== "3.0.0" || service.sourceSha256 !== WINDOWS_AUTHORITY_SERVICE_SOURCE_SHA256
    || !/^[0-9a-f]{64}$/.test(String(service.imageSha256))
    || service.installerSourceSha256 !== WINDOWS_AUTHORITY_SERVICE_INSTALLER_SOURCE_SHA256
    || !/^[0-9a-f]{64}$/.test(String(service.installerSha256))
    || !trust || Array.isArray(trust) || !exactKeys(trust, ["mode", "authenticodeLeafSha256", "authenticodeSpkiSha256"])) return false;
  const production = trust.mode === "production-signed";
  const validation = trust.mode === "unsigned-validation";
  return (production || validation)
    && manifest.format === "propr-windows-authority-helper-v2"
    && manifest.protocolVersion === WINDOWS_AUTHORITY_PROTOCOL_VERSION
    && manifest.sourceSha256 === WINDOWS_AUTHORITY_SUPERVISOR_SOURCE_SHA256
    && manifest.launcherSourceSha256 === WINDOWS_AUTHORITY_LAUNCHER_SOURCE_SHA256
    && /^[0-9a-f]{64}$/.test(String(manifest.helperSha256))
    && /^[0-9a-f]{64}$/.test(String(manifest.launcherSha256))
    && (production
      ? /^[0-9a-f]{64}$/.test(String(trust.authenticodeLeafSha256)) && /^[0-9a-f]{64}$/.test(String(trust.authenticodeSpkiSha256))
        && service.authenticodeLeafSha256 === trust.authenticodeLeafSha256
        && service.authenticodeSpkiSha256 === trust.authenticodeSpkiSha256
      : trust.authenticodeLeafSha256 === null && trust.authenticodeSpkiSha256 === null
        && service.authenticodeLeafSha256 === null && service.authenticodeSpkiSha256 === null);
}

function windowsSupervisorArtifact(): {
  readonly path: string;
  readonly fd: number;
  readonly identity: StableAuthorityIdentity;
  readonly digest: string;
  readonly manifest: WindowsSupervisorManifest;
} {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relative = join("prebuilds", "win32-anycpu");
  const candidates = [
    join(moduleDirectory, "native", relative),
    join(moduleDirectory, "..", "native", relative),
    join(moduleDirectory, "..", "..", "native", relative),
  ];
  for (const directory of candidates) {
    const path = join(directory, "connect-authority-supervisor.exe");
    const manifestPath = join(directory, "connect-authority-supervisor.manifest.json");
    const signaturePath = join(directory, "connect-authority-supervisor.manifest.sig");
    let fd: number | undefined;
    try {
      const manifestBytes = readFileSync(manifestPath);
      const signatureBytes = readFileSync(signaturePath);
      if (manifestBytes.byteLength < 2 || manifestBytes.byteLength > 16 * 1024 || manifestBytes.at(-1) !== 0x0a
        || signatureBytes.byteLength < 2 || signatureBytes.byteLength > 256 || signatureBytes.at(-1) !== 0x0a) {
        throw new WindowsSupervisorStartupError("MANIFEST");
      }
      const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
      const manifest = JSON.parse(manifestText) as unknown;
      if (!exactWindowsSupervisorManifest(manifest) || `${canonicalJson(manifest)}\n` !== manifestText) {
        throw new WindowsSupervisorStartupError("MANIFEST");
      }
      const signature = signatureBytes.toString("ascii").trimEnd();
      if (manifest.trust.mode === "production-signed") {
        if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)
          || !verifySignature(null, manifestBytes, WINDOWS_AUTHORITY_MANIFEST_PUBLIC_KEY, Buffer.from(signature, "base64"))) {
          throw new WindowsSupervisorStartupError("MANIFEST");
        }
      } else if (signature !== "UNSIGNED-VALIDATION" || process.env.PROPR_WINDOWS_AUTHORITY_VALIDATION !== "1") {
        throw new WindowsSupervisorStartupError("MANIFEST");
      }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino
        || stat.size < 1024n || stat.size > BigInt(512 * 1024)) throw new WindowsSupervisorStartupError("HELPER_IDENTITY");
      const digest = createHash("sha256").update(readExactDescriptor(fd, Number(stat.size))).digest("hex");
      if (digest !== manifest.helperSha256) throw new WindowsSupervisorStartupError("HELPER_HASH");
      return {
        path,
        fd,
        identity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
        digest,
        manifest,
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new WindowsSupervisorStartupError("HELPER_OPEN");
}

function readExactDescriptor(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024) {
    throw new Error("packaged native authority broker failed integrity verification");
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("packaged native authority broker failed integrity verification");
    offset += count;
  }
  return bytes;
}

function revalidateAuthorityBroker(
  artifact: { path: string; fd: number; identity: StableAuthorityIdentity; digest: string; bytes: Buffer },
): void {
  const stat = fstatSync(artifact.fd, { bigint: true });
  if (
    !stat.isFile()
    || stat.dev.toString(10) !== artifact.identity.device
    || stat.ino.toString(10) !== artifact.identity.file
    || Number(stat.size) !== artifact.bytes.byteLength
    || createHash("sha256").update(readExactDescriptor(artifact.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
  ) throw new Error("packaged native authority broker was replaced");
}

function stageDarwinAuthorityBroker(artifact: ReturnType<typeof authorityBrokerArtifact>): {
  path: string;
  fd: number;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-capability-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, `broker-${randomUUID()}`);
    const writableFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o500);
    try {
      let offset = 0;
      while (offset < artifact.bytes.byteLength) {
        const count = writeSync(writableFd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
        if (count <= 0) throw new Error("Darwin ACL authority inspection is unavailable");
        offset += count;
      }
      fsyncSync(writableFd);
      fchmodSync(writableFd, 0o500);
      const staged = fstatSync(writableFd, { bigint: true });
      if (!staged.isFile() || staged.size !== BigInt(artifact.bytes.byteLength)) {
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      closeSync(writableFd);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const readable = fstatSync(fd, { bigint: true });
      if (readable.dev !== staged.dev || readable.ino !== staged.ino) {
        closeSync(fd);
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      return { path, fd, directory };
    } catch (error) {
      try { closeSync(writableFd); } catch { /* It was closed before the read-only reopen. */ }
      throw error;
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}



function canonicalUint128(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,38})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffffffffffffffffffn;
}

function stageWindowsAuthorityBroker(artifact: ReturnType<typeof authorityBrokerArtifact>): {
  path: string;
  fd: number;
  directoryFd: number;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-capability-"));
  const path = join(directory, `broker-${randomUUID()}.exe`);
  let writableFd: number | undefined;
  let stagedFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    writableFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    let offset = 0;
    while (offset < artifact.bytes.byteLength) {
      const count = writeSync(writableFd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Windows ACL authority inspection is unavailable");
      offset += count;
    }
    fsyncSync(writableFd);
    closeSync(writableFd);
    writableFd = undefined;

    revalidateAuthorityBroker(artifact);
    stagedFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const staged = fstatSync(stagedFd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !staged.isFile()
      || staged.nlink !== 1n
      || named.isSymbolicLink()
      || staged.dev !== named.dev
      || staged.ino !== named.ino
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(stagedFd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) {
      closeSync(stagedFd);
      stagedFd = undefined;
      throw new Error("packaged native authority broker was replaced");
    }
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { path, fd: stagedFd, directoryFd, directory };
  } catch (error) {
    if (writableFd !== undefined) closeSync(writableFd);
    if (stagedFd !== undefined) closeSync(stagedFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

interface WindowsAuthorityCapability {
  readonly bootstrap: ReturnType<typeof windowsBootstrapArtifact>;
  readonly artifact: ReturnType<typeof authorityBrokerArtifact>;
  readonly helper: ReturnType<typeof windowsSupervisorArtifact>;
  readonly staged: ReturnType<typeof stageWindowsAuthorityBroker>;
  readonly supervisor: ChildProcess;
  readonly channel: WindowsSupervisorChannel;
  heldIdentity?: { readonly volumeSerialNumber: string; readonly fileId: string };
  authorityPid?: string;
  sequence: number;
  lastRequestId: string;
  alive: boolean;
  initialized: boolean;
  testFailureStage?: WindowsSupervisorStage;
}

export interface WindowsAuthorityCapabilityProbe {
  readonly args?: readonly string[];
  readonly onStaged?: (stagedPath: string) => void;
  readonly onPackagedBrokerLocked?: (packagedBrokerPath: string) => void;
  /** Native-test-only replacement probe immediately before final bootstrap identity binding. */
  readonly onBootstrapFirstLaunch?: (bootstrapPath: string) => void;
  /** Native-test-only attack after final binding and before the leased native CreateProcess. */
  readonly onBootstrapCreateProcess?: (bootstrapPath: string) => void;
  /** Native-test-only attack after the outer authority's final self proof and before its first CreateProcess. */
  readonly onOuterAuthorityCreateProcess?: (packagedBrokerPath: string) => void;
  /** Actual first boundary: the machine service holds and authenticated the package image before Node CreateProcess. */
  readonly onInstalledAuthorityAuthorized?: (details: InstalledWindowsLaunchLease["identity"] & {
    readonly servicePid: number; readonly packagedBrokerPath: string;
  }) => void | Promise<void>;
  readonly onSupervisorStarting?: (details: {
    readonly stagedPath: string;
    readonly helperPath: string;
    readonly environmentKeys: readonly string[];
    readonly executable: string;
    readonly packagedBrokerPath: string;
    readonly constantArgv:
      | readonly ["--lease-v2", string, string]
      | readonly ["--lease-validation-v2"]
      | readonly ["--lease-validation-job-failure-v2"];
    readonly manifest: WindowsSupervisorManifest;
  }) => void;
  readonly onSupervisorSpawned?: (stagedPath: string, supervisorPid: number) => void;
  readonly onRequestLocked?: (stagedPath: string, supervisorPid: number) => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** Native-test-only failure injection; never set by production callers. */
  readonly testFailureStage?: WindowsSupervisorStage;
  /** Native-test-only collision injected immediately before the atomic relative NtCreateFile call. */
  readonly testWorkspaceCollisionName?: string;
  /** Native-test-only cleanup probe selected over the anonymous bootstrap stream. */
  readonly testWorkspaceMode?: "normal" | "invalid-handle" | "identity-mismatch" | "cleanup-swap" | "cleanup-contents";
}

let windowsAuthorityCapability: WindowsAuthorityCapability | undefined;
let windowsAuthorityCleanupRegistered = false;
let windowsAuthorityQueue: Promise<void> = Promise.resolve();
let windowsAuthorityFailureGeneration = 0;

function supervisorExists(supervisor: ChildProcess): boolean {
  if (!supervisor.pid || supervisor.exitCode !== null || supervisor.signalCode !== null) return false;
  try {
    return supervisor.kill(0);
  } catch {
    return false;
  }
}

function enterWindowsParentStage(capability: Pick<WindowsAuthorityCapability, "testFailureStage">, stage: WindowsSupervisorStage): void {
  if (capability.testFailureStage === stage) throw new WindowsSupervisorStartupError(stage);
}

function atWindowsCapabilityStage<T>(
  capability: Pick<WindowsAuthorityCapability, "testFailureStage">,
  stage: WindowsSupervisorStage,
  operation: () => T,
): T {
  enterWindowsParentStage(capability, stage);
  try {
    return operation();
  } catch (error) {
    if (error instanceof WindowsSupervisorStartupError) throw error;
    throw new WindowsSupervisorStartupError(stage);
  }
}

function revalidateWindowsCapabilityFiles(capability: WindowsAuthorityCapability): void {
  const named = atWindowsCapabilityStage(capability, "HELPER_OPEN", () => {
    if (!capability.alive || !supervisorExists(capability.supervisor)) throw new Error("unavailable");
    return lstatSync(capability.staged.path, { bigint: true });
  });
  atWindowsCapabilityStage(capability, "HELPER_IDENTITY", () => {
    if (named.isSymbolicLink()) throw new Error("reparse");
  });
  atWindowsCapabilityStage(capability, "HELPER_IDENTITY", () => {
    const staged = fstatSync(capability.staged.fd, { bigint: true });
    const bootstrap = fstatSync(capability.bootstrap.fd, { bigint: true });
    const artifact = fstatSync(capability.artifact.fd, { bigint: true });
    const helper = fstatSync(capability.helper.fd, { bigint: true });
    if (
      !staged.isFile()
      || staged.dev !== named.dev
      || staged.ino !== named.ino
      || staged.size !== BigInt(capability.artifact.bytes.byteLength)
      || !bootstrap.isFile()
      || bootstrap.dev.toString(10) !== capability.bootstrap.identity.device
      || bootstrap.ino.toString(10) !== capability.bootstrap.identity.file
      || !artifact.isFile()
      || artifact.dev.toString(10) !== capability.artifact.identity.device
      || artifact.ino.toString(10) !== capability.artifact.identity.file
      || artifact.size !== BigInt(capability.artifact.bytes.byteLength)
      || !helper.isFile()
      || helper.dev.toString(10) !== capability.helper.identity.device
      || helper.ino.toString(10) !== capability.helper.identity.file
    ) throw new Error("identity");
  });
  atWindowsCapabilityStage(capability, "HELPER_HASH", () => {
    if (
      createHash("sha256")
        .update(readExactDescriptor(capability.staged.fd, capability.artifact.bytes.byteLength))
        .digest("hex") !== capability.artifact.digest
      || createHash("sha256")
        .update(readExactDescriptor(capability.bootstrap.fd, capability.bootstrap.bytes.byteLength))
        .digest("hex") !== capability.bootstrap.digest
      || createHash("sha256")
        .update(readExactDescriptor(capability.artifact.fd, capability.artifact.bytes.byteLength))
        .digest("hex") !== capability.artifact.digest
      || createHash("sha256")
        .update(readExactDescriptor(capability.helper.fd, Number(fstatSync(capability.helper.fd).size)))
        .digest("hex") !== capability.helper.digest
    ) throw new Error("hash");
  });
}

export class WindowsSupervisorStartupError extends Error {
  constructor(readonly stage: WindowsSupervisorStage) {
    super(`Windows system authority capability is unavailable (${stage})`);
    this.name = "WindowsSupervisorStartupError";
  }
}

export interface WindowsAuthorityStageTestResult {
  readonly version: 1;
  readonly status: "failed";
  readonly stage: WindowsSupervisorStage;
  readonly publicError: "Windows system authority capability is unavailable";
}

function requireWindowsProductionBuildEvidence(requestedStage: WindowsSupervisorStage): void {
  const receiptPath = process.env.PROPR_WINDOWS_BUILD_EVIDENCE_RECEIPT;
  if (!receiptPath) throw new Error("production build evidence is unavailable");
  const receiptBytes = readFileSync(receiptPath);
  if (receiptBytes.byteLength < 2 || receiptBytes.byteLength > 4096 || receiptBytes.at(-1) !== 0x0a) {
    throw new Error("production build evidence is malformed");
  }
  const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)) as unknown;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || !exactKeys(receipt as Record<string, unknown>, ["version", "stages"])
    || (receipt as Record<string, unknown>).version !== 2
    || !Array.isArray((receipt as Record<string, unknown>).stages)) {
    throw new Error("production build evidence is malformed");
  }
  const stages = (receipt as { stages: unknown[] }).stages;
  const expected = [["BUILD_COMPILER", 6], ["BUILD_SOURCE", 6], ["BUILD_OUTPUT", 6]] as const;
  if (stages.length !== expected.length || !stages.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !exactKeys(item as Record<string, unknown>, ["stage", "diagnostic", "nonceAuthenticated", "hookAuthenticated",
        "mutationAttempted", "mutationDenied", "childAndJobsTerminated", "publishedArtifactsChanged",
        "baselineArtifactsChanged", "stagingResidueChanged"])) return false;
    const record = item as Record<string, unknown>;
    return record.stage === expected[index][0]
      && record.diagnostic === expected[index][1]
      && record.nonceAuthenticated === true && record.hookAuthenticated === true
      && record.mutationAttempted === true && record.mutationDenied === true
      && record.childAndJobsTerminated === true
      && record.publishedArtifactsChanged === 0 && record.baselineArtifactsChanged === 0
      && record.stagingResidueChanged === 0;
  }) || !expected.some(([stage]) => stage === requestedStage)) {
    throw new Error("production build evidence is incomplete");
  }
}

/** Resolve only a bounded production stage through a fixed-length cause chain. */
export function windowsAuthorityStageFromError(error: unknown): WindowsSupervisorStage | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof WindowsSupervisorStartupError && WINDOWS_SUPERVISOR_STAGES.has(current.stage)) {
      return current.stage;
    }
    current = current.cause;
  }
  return undefined;
}

interface PendingSupervisorFrame {
  readonly resolve: (value: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly expectedExit?: {
    readonly code: number;
    readonly authenticate: (frame: Buffer) => boolean;
  };
  onTimeout?: () => void;
  onAbort?: () => void;
}

type WindowsChannelInvalidationClass =
  | "protocol-extra-output"
  | "protocol-malformed"
  | "protocol-frame-limit"
  | "stderr-output"
  | "stdout-error"
  | "stdin-error"
  | "stderr-error"
  | "process-error"
  | "unexpected-eof"
  | "unexpected-exit"
  | "timeout"
  | "abort"
  | "write-error"
  | "authority-failure"
  | "shutdown";

interface SettlingSupervisorFrame {
  readonly pending: PendingSupervisorFrame;
  readonly frame: Buffer;
  readonly immediate: NodeJS.Immediate;
  readonly expectedExitCode?: number;
}

class WindowsSupervisorChannel {
  private buffered = Buffer.alloc(0);
  private expectedLength: number | undefined;
  private pending: PendingSupervisorFrame | undefined;
  private settling: SettlingSupervisorFrame | undefined;
  private frameCount = 0;
  private invalidError: Error | undefined;
  private invalidationClass: WindowsChannelInvalidationClass | undefined;
  private closing = false;
  private settlingProbe: ((pending: PendingSupervisorFrame) => void) | undefined;

  constructor(readonly supervisor: ChildProcess) {
    if (!supervisor.stdin || !supervisor.stdout || !supervisor.stderr) {
      throw new WindowsSupervisorStartupError("TRANSPORT_SPAWN");
    }
    supervisor.stdout.on("data", (chunk: Buffer | string) => this.receive(Buffer.from(chunk)));
    supervisor.stdout.once("end", () => {
      if (this.settling?.expectedExitCode !== undefined) {
        return;
      }
      this.invalidate(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"), "unexpected-eof");
    });
    supervisor.stdout.once("error", () => this.invalidate(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"), "stdout-error"));
    supervisor.stdin.once("error", () => this.invalidate(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"), "stdin-error"));
    supervisor.stderr.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(chunk) > 0) this.invalidate(new WindowsSupervisorStartupError("PROTOCOL_INIT"), "stderr-output");
    });
    supervisor.stderr.once("error", () => this.invalidate(new WindowsSupervisorStartupError("PROTOCOL_INIT"), "stderr-error"));
    supervisor.once("error", () => this.invalidate(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"), "process-error"));
    supervisor.once("exit", (code, signal) => {
      const settling = this.settling;
      if (settling?.expectedExitCode === code && signal === null) {
        this.acceptExpectedExit(settling);
        return;
      }
      this.invalidate(
        new WindowsSupervisorStartupError(this.closing ? "SHUTDOWN" : "TRANSPORT_SPAWN"),
        "unexpected-exit",
      );
    });
  }

  private clearPending(pending: PendingSupervisorFrame): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private acceptExpectedExit(settling: SettlingSupervisorFrame): void {
    if (this.settling !== settling) return;
    clearImmediate(settling.immediate);
    this.settling = undefined;
    this.clearPending(settling.pending);
    settling.pending.resolve(settling.frame);
  }

  private receive(chunk: Buffer): void {
    if (this.invalidError || chunk.byteLength === 0) return;
    if (!this.pending || this.settling) {
      this.invalidate(new Error("Windows system authority capability emitted extra output"), "protocol-extra-output");
      return;
    }
    if (this.buffered.byteLength + chunk.byteLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES + 4) {
      this.invalidate(new Error("Windows system authority capability was malformed"), "protocol-malformed");
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.expectedLength === undefined && this.buffered.byteLength >= 4) {
      this.expectedLength = this.buffered.readUInt32LE(0);
      if (this.expectedLength < 2 || this.expectedLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES) {
        this.invalidate(new Error("Windows system authority capability was malformed"), "protocol-malformed");
        return;
      }
    }
    if (this.expectedLength === undefined || this.buffered.byteLength < this.expectedLength + 4) return;
    if (this.buffered.byteLength !== this.expectedLength + 4) {
      this.invalidate(new Error("Windows system authority capability emitted extra output"), "protocol-extra-output");
      return;
    }
    this.frameCount += 1;
    if (this.frameCount > WINDOWS_CAPABILITY_MAX_MESSAGES + 1) {
      this.invalidate(new Error("Windows system authority capability exceeded its frame limit"), "protocol-frame-limit");
      return;
    }
    const frame = this.buffered.subarray(4);
    this.buffered = Buffer.alloc(0);
    this.expectedLength = undefined;
    const pending = this.pending;
    this.pending = undefined;
    const immediate = setImmediate(() => {
      if (this.settling?.pending !== pending) return;
      this.settling = undefined;
      this.clearPending(pending);
      pending.resolve(frame);
    });
    let expectedExitCode: number | undefined;
    try {
      if (pending.expectedExit?.authenticate(frame)) expectedExitCode = pending.expectedExit.code;
    } catch { /* Authentication failure is an ordinary non-expected frame. */ }
    this.settling = { pending, frame, immediate, expectedExitCode };
    const probe = this.settlingProbe;
    this.settlingProbe = undefined;
    probe?.(pending);
  }

  invalidate(
    error: Error,
    invalidationClass: WindowsChannelInvalidationClass = "authority-failure",
    poisonQueued = !this.closing,
  ): void {
    if (this.invalidError) return;
    this.invalidError = error;
    this.invalidationClass = invalidationClass;
    if (poisonQueued) windowsAuthorityFailureGeneration += 1;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      this.clearPending(pending);
      pending.reject(error);
    }
    const settling = this.settling;
    this.settling = undefined;
    if (settling) {
      clearImmediate(settling.immediate);
      this.clearPending(settling.pending);
      settling.pending.reject(error);
    }
    this.supervisor.stdin?.destroy();
    this.supervisor.stdout?.destroy();
    this.supervisor.stderr?.destroy();
  }

  async exchange(
    value: unknown,
    timeout: number,
    signal?: AbortSignal,
    prefix?: Buffer,
    expectedExit?: PendingSupervisorFrame["expectedExit"],
  ): Promise<Buffer> {
    if (this.invalidError) throw this.invalidError;
    if (this.pending || this.settling) throw new Error("Windows system authority capability request ordering failed");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted");
    const response = new Promise<Buffer>((resolve, reject) => {
      const pending: PendingSupervisorFrame = {
        resolve,
        reject,
        signal,
        expectedExit,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      pending.onTimeout = () => this.invalidate(
        new Error("Windows system authority capability timed out"),
        "timeout",
      );
      (pending as { timer: NodeJS.Timeout }).timer = setTimeout(pending.onTimeout, timeout);
      if (signal) {
        pending.onAbort = () => this.invalidate(
          signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted"),
          "abort",
        );
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending = pending;
    });
    try {
      const control = encodeControlFrame(value);
      await this.write(prefix ? Buffer.concat([prefix, control]) : control);
    } catch (error) {
      this.invalidate(
        error instanceof Error ? error : new Error("Windows system authority capability is unavailable"),
        "write-error",
      );
    }
    return response;
  }

  async write(bytes: Buffer): Promise<void> {
    if (this.invalidError || !this.supervisor.stdin || this.supervisor.stdin.destroyed) {
      throw this.invalidError ?? new Error("Windows system authority capability is unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      const stream = this.supervisor.stdin!;
      let callbackDone = false;
      let drained = true;
      const finish = () => { if (callbackDone && drained) resolve(); };
      const accepted = stream.write(bytes, (error) => {
        if (error) reject(error);
        else { callbackDone = true; finish(); }
      });
      if (!accepted) {
        drained = false;
        stream.once("drain", () => { drained = true; finish(); });
      }
    });
  }

  beginShutdown(): void {
    this.closing = true;
  }

  installSettlingProbeForNativeTest(probe: (pending: PendingSupervisorFrame) => void): void {
    if (this.settlingProbe) throw new Error("Windows channel settling probe is already active");
    this.settlingProbe = probe;
  }

  invalidationClassForNativeTest(): WindowsChannelInvalidationClass | undefined {
    return this.invalidationClass;
  }
}

function encodeControlFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 2 || payload.byteLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES) {
    throw new Error("Windows system authority capability was malformed");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function isAuthenticatedWindowsStartupError(frame: Buffer, requestId: string): boolean {
  const document = parseWindowsCapabilityDocument(frame);
  if (!document || !exactKeys(document, ["version", "kind", "requestId", "stage"])) return false;
  const stage = document.stage;
  return document.version === WINDOWS_AUTHORITY_PROTOCOL_VERSION
    && document.kind === "startup-error"
    && typeof stage === "string"
    && WINDOWS_SUPERVISOR_STAGES.has(stage as WindowsSupervisorStage)
    && (document.requestId === requestId
      || (document.requestId === "0".repeat(32) && stage === "PROTOCOL_INIT"));
}

async function exchangeWindowsCapability(
  capability: WindowsAuthorityCapability,
  requestId: string,
  operation: "challenge" | "stop",
  timeout = WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!capability.alive || !supervisorExists(capability.supervisor)) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const expectedExit = operation === "stop" ? {
    code: 0,
    authenticate: (frame: Buffer) => isAuthenticatedWindowsCapabilityResponse(
      capability,
      "stop",
      requestId,
      frame,
    ),
  } : undefined;
  return capability.channel.exchange(
    { version: WINDOWS_AUTHORITY_PROTOCOL_VERSION, kind: operation, requestId },
    timeout,
    signal,
    undefined,
    expectedExit,
  );
}

function parseWindowsCapabilityDocument(output: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeBoundedUtf8(output));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isAuthenticatedWindowsCapabilityResponse(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop",
  requestId: string,
  output: Buffer,
): boolean {
  const document = parseWindowsCapabilityDocument(output);
  const heldIdentity = capability.heldIdentity;
  return document !== undefined
    && exactKeys(document, [
      "version", "kind", "requestId", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256",
    ])
    && document.version === WINDOWS_AUTHORITY_PROTOCOL_VERSION
    && document.kind === (operation === "stop" ? "stopped" : "ready")
    && document.requestId === requestId
    && document.supervisorPid === capability.authorityPid
    && Number.isInteger(document.sequence)
    && document.sequence === capability.sequence + 1
    && canonicalUint64(document.volumeSerialNumber)
    && canonicalUint128(document.fileId)
    && heldIdentity !== undefined
    && document.volumeSerialNumber === heldIdentity.volumeSerialNumber
    && document.fileId === heldIdentity.fileId
    && document.sha256 === capability.artifact.digest;
}

function validateWindowsCapabilityResponse(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop",
  requestId: string,
  output: Buffer,
): void {
  const parsed = parseWindowsCapabilityDocument(output);
  const heldIdentity = capability.heldIdentity;
  if (parsed) {
    const failure = parsed as Record<string, unknown>;
    if (exactKeys(failure, [
      "version", "kind", "requestId", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256", "stage",
    ]) && failure.version === WINDOWS_AUTHORITY_PROTOCOL_VERSION && failure.kind === "capability-error"
      && failure.requestId === requestId && failure.supervisorPid === capability.authorityPid
      && failure.sequence === capability.sequence && heldIdentity
      && failure.volumeSerialNumber === heldIdentity.volumeSerialNumber
      && failure.fileId === heldIdentity.fileId && failure.sha256 === capability.artifact.digest
      && typeof failure.stage === "string" && WINDOWS_SUPERVISOR_STAGES.has(failure.stage as WindowsSupervisorStage)) {
      throw new WindowsSupervisorStartupError(failure.stage as WindowsSupervisorStage);
    }
  }
  if (
    !parsed
    || !exactKeys(parsed, [
      "version", "kind", "requestId", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256",
    ])
  ) throw new Error("Windows system authority capability was malformed");
  const document = parsed;
  if (
    document.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION
    || document.kind !== (operation === "stop" ? "stopped" : "ready")
    || document.requestId !== requestId
    || document.supervisorPid !== capability.authorityPid
    || !Number.isInteger(document.sequence)
    || (document.sequence as number) < 1
    || document.sequence !== capability.sequence + 1
    || !canonicalUint64(document.volumeSerialNumber)
    || !canonicalUint128(document.fileId)
    || !heldIdentity
    || document.volumeSerialNumber !== heldIdentity.volumeSerialNumber
    || document.fileId !== heldIdentity.fileId
    || document.sha256 !== capability.artifact.digest
  ) throw new Error("Windows system authority capability was malformed");
  capability.sequence = document.sequence as number;
  capability.lastRequestId = requestId;
}

async function challengeWindowsCapability(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop" = "challenge",
  signal?: AbortSignal,
): Promise<void> {
  if (!capability.alive || !supervisorExists(capability.supervisor) || !capability.supervisor.pid) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const requestId = randomBytes(16).toString("hex");
  const output = await exchangeWindowsCapability(capability, requestId, operation, undefined, signal);
  validateWindowsCapabilityResponse(capability, operation, requestId, output);
}

function closeWindowsCapabilityFiles(capability: WindowsAuthorityCapability): void {
  try { closeSync(capability.staged.fd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.staged.directoryFd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.artifact.fd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.helper.fd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.bootstrap.fd); } catch { /* Already closed during failed acquisition. */ }
  try { rmSync(capability.staged.directory, { recursive: true, force: true }); } catch { /* Best effort after native close. */ }
}

async function waitForSupervisorExit(supervisor: ChildProcess, timeout: number): Promise<boolean> {
  if (!supervisorExists(supervisor)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
    const exited = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); supervisor.removeListener("exit", exited); };
    supervisor.once("exit", exited);
  });
}

async function destroyWindowsAuthorityCapability(
  capability = windowsAuthorityCapability,
  requireGracefulShutdown = false,
): Promise<void> {
  if (!capability) {
    if (requireGracefulShutdown) throw new WindowsSupervisorStartupError("SHUTDOWN");
    return;
  }
  if (windowsAuthorityCapability === capability) windowsAuthorityCapability = undefined;
  let gracefulShutdown = false;
  if (capability.initialized && capability.alive && supervisorExists(capability.supervisor)) {
    capability.channel.beginShutdown();
    try {
      await challengeWindowsCapability(capability, "stop");
      gracefulShutdown = true;
    } catch { /* Channel failure falls through to forced reap. */ }
  }
  capability.alive = false;
  capability.supervisor.stdin?.end();
  let exited = await waitForSupervisorExit(capability.supervisor, WINDOWS_CAPABILITY_STOP_TIMEOUT_MS);
  if (!exited) {
    try { capability.supervisor.kill(); } catch { /* The OS also closes the lock when the parent exits. */ }
    exited = await waitForSupervisorExit(capability.supervisor, WINDOWS_CAPABILITY_STOP_TIMEOUT_MS);
  }
  capability.channel.invalidate(new WindowsSupervisorStartupError("SHUTDOWN"), "shutdown", false);
  closeWindowsCapabilityFiles(capability);
  if (requireGracefulShutdown && (!gracefulShutdown || !exited)) {
    throw new WindowsSupervisorStartupError("SHUTDOWN");
  }
}

async function acquireWindowsAuthorityCapability(
  probe?: Pick<WindowsAuthorityCapabilityProbe, "onStaged" | "onPackagedBrokerLocked" | "onBootstrapFirstLaunch" | "onBootstrapCreateProcess" | "onOuterAuthorityCreateProcess" | "onInstalledAuthorityAuthorized" | "onSupervisorStarting" | "onSupervisorSpawned" | "testFailureStage" | "testWorkspaceCollisionName" | "testWorkspaceMode">,
  signal?: AbortSignal,
): Promise<WindowsAuthorityCapability> {
  if (windowsAuthorityCapability) {
    if (probe) throw new Error("Windows system authority capability is already active");
    try {
      revalidateWindowsCapabilityFiles(windowsAuthorityCapability);
      return windowsAuthorityCapability;
    } catch (error) {
      const stagedError = error instanceof WindowsSupervisorStartupError
        ? error
        : new WindowsSupervisorStartupError("HELPER_IDENTITY");
      windowsAuthorityCapability.channel.invalidate(
        stagedError,
      );
      await destroyWindowsAuthorityCapability(windowsAuthorityCapability);
      throw stagedError;
    }
  }
  let artifact: ReturnType<typeof authorityBrokerArtifact>;
  let bootstrap: ReturnType<typeof windowsBootstrapArtifact>;
  let helper: ReturnType<typeof windowsSupervisorArtifact>;
  try {
    helper = windowsSupervisorArtifact();
  } catch (error) {
    throw error;
  }
  try {
    bootstrap = windowsBootstrapArtifact();
  } catch (error) {
    closeSync(helper.fd);
    throw error;
  }
  try {
    // Windows on Arm64 provides the audited x64 emulation boundary; the
    // managed supervisor remains AnyCPU and executes natively after launch.
    artifact = authorityBrokerArtifact("win32", "x64", helper.manifest.launcherSha256);
  } catch (error) {
    closeSync(bootstrap.fd);
    closeSync(helper.fd);
    throw error instanceof WindowsSupervisorStartupError ? error : new WindowsSupervisorStartupError("HELPER_OPEN");
  }
  let staged: ReturnType<typeof stageWindowsAuthorityBroker> | undefined;
  let capability: WindowsAuthorityCapability | undefined;
  let supervisor: ChildProcess | undefined;
  let installedLaunchLease: InstalledWindowsLaunchLease | undefined;
  let parentStage: WindowsSupervisorStage = "HELPER_OPEN";
  try {
    staged = stageWindowsAuthorityBroker(artifact);
    parentStage = "TRANSPORT_SPAWN";
    if (probe?.testFailureStage === parentStage) throw new WindowsSupervisorStartupError(parentStage);
    const supervisorEnvironment = {};
    // The packaged, checksum-bound native broker is already authenticated by
    // the signed helper manifest and is the outer launch authority. It leases
    // and launches the bootstrap; the bootstrap separately leases and launches
    // the packaged broker child.
    const executable = artifact.path;
    const constantArgv = probe?.testFailureStage === "JOB_ASSIGN"
      ? ["--lease-validation-job-failure-v2"] as const
      : helper.manifest.trust.mode === "production-signed"
      ? [
        "--lease-v2",
        helper.manifest.trust.authenticodeLeafSha256!,
        helper.manifest.trust.authenticodeSpkiSha256!,
      ] as const
      : ["--lease-validation-v2"] as const;
    probe?.onSupervisorStarting?.({
      stagedPath: staged.path,
      helperPath: helper.path,
      environmentKeys: Object.freeze(Object.keys(supervisorEnvironment)),
      executable,
      packagedBrokerPath: artifact.path,
      constantArgv,
      manifest: helper.manifest,
    });
    const zeroPin = "0".repeat(64);
    const launchMode = probe?.testFailureStage === "JOB_ASSIGN"
      ? "validation-job-failure"
      : helper.manifest.trust.mode === "production-signed" ? "production" : "validation";
    const brokerArgv = [
      "launch-staged-broker-v1",
      staged.path,
      launchMode,
      artifact.digest,
      helper.path,
      launchMode,
      helper.digest,
      helper.manifest.trust.authenticodeLeafSha256 ?? zeroPin,
      helper.manifest.trust.authenticodeSpkiSha256 ?? zeroPin,
    ];
    const launcherArgv = [
      "launch-packaged-broker-v1",
      artifact.path,
      artifact.digest,
      helper.manifest.trust.mode === "production-signed" ? "production" : "validation",
      helper.manifest.trust.authenticodeLeafSha256 ?? zeroPin,
      helper.manifest.trust.authenticodeSpkiSha256 ?? zeroPin,
      artifact.path,
      ...brokerArgv,
    ];
    probe?.onBootstrapFirstLaunch?.(bootstrap.path);
    // Bind the first CreateProcess name to the already held immutable package
    // bytes at the last synchronous boundary available to the caller.
    revalidateWindowsBootstrapArtifact(bootstrap);
    const bootstrapLauncherArgv = [
      "launch-bootstrap-v1",
      bootstrap.path,
      bootstrap.digest,
      helper.manifest.trust.mode === "production-signed" ? "production" : "validation",
      artifact.digest,
      helper.manifest.trust.authenticodeLeafSha256 ?? zeroPin,
      helper.manifest.trust.authenticodeSpkiSha256 ?? zeroPin,
      bootstrap.path,
      ...launcherArgv,
    ];
    installedLaunchLease = await acquireInstalledWindowsLaunchLease({ path: artifact.path, sha256: artifact.digest }, {
      serviceVersion: helper.manifest.service.version,
      sha256: helper.manifest.service.imageSha256,
      authenticodeLeafSha256: helper.manifest.service.authenticodeLeafSha256 ?? zeroPin,
      authenticodeSpkiSha256: helper.manifest.service.authenticodeSpkiSha256 ?? zeroPin,
    });
    await probe?.onInstalledAuthorityAuthorized?.({
      ...installedLaunchLease.identity,
      servicePid: installedLaunchLease.servicePid,
      packagedBrokerPath: artifact.path,
    });
    supervisor = spawn(executable, bootstrapLauncherArgv, {
      shell: false,
      windowsHide: true,
      env: supervisorEnvironment,
      // fd 5 is the staged-broker barrier; fd 7 is the packaged-broker
      // barrier; fd 8 binds the bootstrap object; fd 9 is the bootstrap
      // pre-CreateProcess barrier; fd 10 attacks the outer authority's exact
      // final-self-check-to-first-CreateProcess boundary.
      stdio: ["pipe", "pipe", "pipe", staged.fd, helper.fd, "pipe", artifact.fd, "pipe", bootstrap.fd, "pipe", "pipe"],
    });
    if (!supervisor.pid) throw new WindowsSupervisorStartupError("TRANSPORT_SPAWN");
    await installedLaunchLease.confirm(supervisor.pid);
    const launchBarrier = (supervisor.stdio as unknown as Array<NodeJS.ReadWriteStream | null>)[5];
    const packagedBarrier = (supervisor.stdio as unknown as Array<NodeJS.ReadWriteStream | null>)[7];
    const bootstrapBarrier = (supervisor.stdio as unknown as Array<NodeJS.ReadWriteStream | null>)[9];
    const outerAuthorityBarrier = (supervisor.stdio as unknown as Array<NodeJS.ReadWriteStream | null>)[10];
    if (!launchBarrier || !packagedBarrier || !bootstrapBarrier || !outerAuthorityBarrier
      || typeof (launchBarrier as NodeJS.ReadWriteStream).write !== "function"
      || typeof (packagedBarrier as NodeJS.ReadWriteStream).write !== "function"
      || typeof (bootstrapBarrier as NodeJS.ReadWriteStream).write !== "function"
      || typeof (outerAuthorityBarrier as NodeJS.ReadWriteStream).write !== "function") {
      throw new WindowsSupervisorStartupError("TRANSPORT_SPAWN");
    }
    const awaitLeaseBarrier = (barrier: NodeJS.ReadWriteStream) => new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        barrier.off("data", onData);
        supervisor!.off("error", onError);
        supervisor!.off("exit", onExit);
        if (error) reject(error); else resolve();
      };
      const onData = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.byteLength !== 1 || bytes[0] !== 0x52) finish(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"));
        else finish();
      };
      const onError = () => finish(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"));
      const onExit = () => finish(new WindowsSupervisorStartupError("TRANSPORT_SPAWN"));
      timer = setTimeout(() => finish(new WindowsSupervisorStartupError("TRANSPORT_SPAWN")), WINDOWS_CAPABILITY_STARTUP_TIMEOUT_MS);
      barrier.once("data", onData);
      supervisor!.once("error", onError);
      supervisor!.once("exit", onExit);
    });
    await awaitLeaseBarrier(outerAuthorityBarrier as NodeJS.ReadWriteStream);
    try {
      probe?.onOuterAuthorityCreateProcess?.(artifact.path);
      (outerAuthorityBarrier as NodeJS.ReadWriteStream).end(Buffer.from("G"));
    } catch (error) {
      (outerAuthorityBarrier as NodeJS.ReadWriteStream).end(Buffer.from("X"));
      throw error;
    }
    await installedLaunchLease.release();
    installedLaunchLease = undefined;
    await awaitLeaseBarrier(bootstrapBarrier as NodeJS.ReadWriteStream);
    try {
      probe?.onBootstrapCreateProcess?.(bootstrap.path);
      (bootstrapBarrier as NodeJS.ReadWriteStream).end(Buffer.from("G"));
    } catch (error) {
      (bootstrapBarrier as NodeJS.ReadWriteStream).end(Buffer.from("X"));
      throw error;
    }
    await awaitLeaseBarrier(packagedBarrier as NodeJS.ReadWriteStream);
    try {
      probe?.onPackagedBrokerLocked?.(artifact.path);
      (packagedBarrier as NodeJS.ReadWriteStream).end(Buffer.from("G"));
    } catch (error) {
      (packagedBarrier as NodeJS.ReadWriteStream).end(Buffer.from("X"));
      throw error;
    }
    await awaitLeaseBarrier(launchBarrier as NodeJS.ReadWriteStream);
    // This is the real pre-CreateProcess mutation barrier: the native parent
    // already owns its deny-write/delete/rename lease, and will not create the
    // staged process until the hook has attempted its attack.
    try {
      probe?.onStaged?.(staged.path);
      (launchBarrier as NodeJS.ReadWriteStream).end(Buffer.from("G"));
    } catch (error) {
      (launchBarrier as NodeJS.ReadWriteStream).end(Buffer.from("X"));
      throw error;
    }
    const channel = new WindowsSupervisorChannel(supervisor);
    supervisor.unref();
    (supervisor.stdin as typeof supervisor.stdin & { unref?: () => void } | null)?.unref?.();
    (supervisor.stdout as typeof supervisor.stdout & { unref?: () => void } | null)?.unref?.();
    (supervisor.stderr as typeof supervisor.stderr & { unref?: () => void } | null)?.unref?.();
    capability = {
      bootstrap,
      artifact,
      helper,
      staged,
      supervisor,
      channel,
      sequence: 0,
      lastRequestId: "",
      alive: true,
      initialized: false,
      testFailureStage: probe?.testFailureStage,
    };
    supervisor.once("error", () => { capability!.alive = false; });
    supervisor.once("exit", () => { capability!.alive = false; });
    // The pid is the packaged native launch authority. Its child broker and
    // supervisor remain in the same kill-on-close job tree.
    probe?.onSupervisorSpawned?.(staged.path, supervisor.pid);
    parentStage = "PROTOCOL_INIT";
    const requestId = randomBytes(16).toString("hex");
    if (probe?.testFailureStage === "PROTOCOL_INIT") {
      throw new WindowsSupervisorStartupError("PROTOCOL_INIT");
    }
    const output = await channel.exchange({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
      kind: "init",
      requestId,
      path: staged.path,
      sha256: artifact.digest,
      parentPid: String(process.pid),
      ...(probe?.testFailureStage === undefined ? {} : { testFailureStage: probe.testFailureStage }),
    }, WINDOWS_CAPABILITY_STARTUP_TIMEOUT_MS, signal, undefined, {
      code: 23,
      authenticate: (frame) => isAuthenticatedWindowsStartupError(frame, requestId),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBoundedUtf8(output));
    } catch {
      throw new WindowsSupervisorStartupError("PROTOCOL_INIT");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const startup = parsed as Record<string, unknown>;
      const startupStage = typeof startup.stage === "string"
        && WINDOWS_SUPERVISOR_STAGES.has(startup.stage as WindowsSupervisorStage)
        ? startup.stage as WindowsSupervisorStage
        : undefined;
      if (exactKeys(startup, ["version", "kind", "requestId", "stage"])
        && startup.version === WINDOWS_AUTHORITY_PROTOCOL_VERSION && startup.kind === "startup-error" && startupStage
        && (startup.requestId === requestId
          || (startup.requestId === "0".repeat(32) && startupStage === "PROTOCOL_INIT"))) {
        throw new WindowsSupervisorStartupError(startupStage);
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !exactKeys(parsed, [
      "version", "kind", "requestId", "supervisorPid", "sequence", "volumeSerialNumber", "fileId", "sha256",
    ])) throw new WindowsSupervisorStartupError("READY");
    const ready = parsed as Record<string, unknown>;
    if (ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.kind !== "ready" || ready.requestId !== requestId
      || !canonicalUint64(ready.supervisorPid) || ready.supervisorPid === String(process.pid) || ready.sequence !== 1
      || !canonicalUint64(ready.volumeSerialNumber) || !canonicalUint128(ready.fileId)
      || ready.sha256 !== artifact.digest) throw new WindowsSupervisorStartupError("READY");
    capability.heldIdentity = {
      volumeSerialNumber: ready.volumeSerialNumber,
      fileId: ready.fileId,
    };
    capability.authorityPid = ready.supervisorPid;
    capability.sequence = 1;
    capability.lastRequestId = requestId;
    capability.initialized = true;
    parentStage = "HELPER_IDENTITY";
    revalidateWindowsCapabilityFiles(capability);
    windowsAuthorityCapability = capability;
    if (!windowsAuthorityCleanupRegistered) {
      windowsAuthorityCleanupRegistered = true;
      process.once("beforeExit", () => { void closeWindowsAuthorityCapability(); });
      process.once("exit", () => {
        const current = windowsAuthorityCapability;
        if (!current) return;
        current.channel.beginShutdown();
        current.supervisor.kill();
        closeWindowsCapabilityFiles(current);
      });
    }
    return capability;
  } catch (error) {
    if (installedLaunchLease) {
      try { await installedLaunchLease.release(); } catch { /* Closing the authenticated pipe releases the OS lease. */ }
    }
    if (capability) {
      capability.channel.invalidate(
        error instanceof Error ? error : new WindowsSupervisorStartupError(parentStage),
      );
      await destroyWindowsAuthorityCapability(capability);
    }
    else {
      if (supervisor) {
        try { supervisor.kill(); } catch { /* Failed startup may already have exited. */ }
        supervisor.stdin?.destroy();
        supervisor.stdout?.destroy();
        supervisor.stderr?.destroy();
      }
      if (staged) {
        try { closeSync(staged.fd); } catch { /* Acquisition cleanup. */ }
        try { closeSync(staged.directoryFd); } catch { /* Acquisition cleanup. */ }
        try { rmSync(staged.directory, { recursive: true, force: true }); } catch { /* Acquisition cleanup. */ }
      }
      closeSync(artifact.fd);
      closeSync(bootstrap.fd);
      closeSync(helper.fd);
    }
    if (error instanceof WindowsSupervisorStartupError) throw error;
    if (error instanceof WindowsInstalledAuthorityError) throw error;
    throw new WindowsSupervisorStartupError(parentStage);
  }
}

function validWindowsBatchRequest(input: Buffer | undefined, targetCount: number): boolean {
  if (
    !input
    || targetCount < 1
    || targetCount > 64
    || input.byteLength === 0
    || input.byteLength > WINDOWS_BROKER_REQUEST_MAX_BYTES
    || input[input.byteLength - 1] !== 0x0a
  ) return false;
  for (const byte of input) {
    if (byte > 0x7f || byte === 0 || byte === 0x0d) return false;
  }
  const lines = input.toString("ascii").split("\n");
  if (
    lines.length !== targetCount + 5
    || lines.at(-1) !== ""
    || lines[0] !== "PROPR_AUTHORITY_V1"
    || !/^[0-9a-f]{32}$/.test(lines[1])
    || (lines[2] !== "inspect" && lines[2] !== "protect")
    || lines[3] !== String(targetCount)
  ) return false;
  const allowed = lines[2] === "inspect"
    ? new Set(["ancestor", "home", "root", "data", "env"])
    : new Set(["directory", "file"]);
  return lines.slice(4, -1).every((kind) => allowed.has(kind));
}

interface BoundedChildResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function runBoundedWindowsChild(
  path: string,
  args: readonly string[],
  targetFds: readonly number[],
  input: Buffer | undefined,
  signal?: AbortSignal,
): Promise<BoundedChildResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Windows authority batch timed out")), WINDOWS_BROKER_BATCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const child = spawn(path, [...args], {
      shell: false,
      windowsHide: true,
      env: {},
      signal: controller.signal,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe", ...targetFds],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const collect = (target: Buffer[], kind: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      if (kind === "stdout") stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
      if (stdoutBytes > NATIVE_INSPECTION_MAX_BYTES || stderrBytes > NATIVE_INSPECTION_MAX_BYTES) {
        controller.abort(new Error("Windows authority batch exceeded its output limit"));
        return;
      }
      target.push(bytes);
    };
    child.stdout!.on("data", collect(stdout, "stdout"));
    child.stderr!.on("data", collect(stderr, "stderr"));
    const completion = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdin?.once("error", reject);
      child.once("close", (code, closeSignal) => {
        if (code === null || closeSignal !== null) reject(controller.signal.reason ?? new Error("Windows authority batch failed"));
        else resolve(code);
      });
    });
    if (input) child.stdin!.end(input);
    const status = await completion;
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runCachedWindowsAuthorityBroker(
  args: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
  input?: Buffer,
  onRequestLocked?: (stagedPath: string, supervisorPid: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const batch = args.length === 1 && args[0] === "batch-v1";
  const probe = args.length === 1 && (args[0] === "ping" || args[0] === "ping-hold");
  if (
    (!batch && !probe)
    || targetFds.some((fd) => !Number.isInteger(fd) || fd < 0)
    || (probe && (targetFds.length !== 0 || input !== undefined))
    || (batch && !validWindowsBatchRequest(input, targetFds.length))
  ) throw new Error(failureMessage);
  const capability = await acquireWindowsAuthorityCapability(undefined, signal);
  let stage: WindowsSupervisorStage = "PRE_CHALLENGE";
  try {
    revalidateWindowsCapabilityFiles(capability);
    await challengeWindowsCapability(capability, "challenge", signal);
    await onRequestLocked?.(capability.staged.path, capability.supervisor.pid!);
    if (!supervisorExists(capability.supervisor)) throw new Error(failureMessage);
    stage = "BATCH_LAUNCH";
    enterWindowsParentStage(capability, stage);
    let result: BoundedChildResult;
    try {
      result = await runBoundedWindowsChild(capability.staged.path, args, targetFds, input, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      throw new WindowsSupervisorStartupError(code === "EBADF" || code === "EINVAL" ? "FD_DUPLICATE" : "BATCH_LAUNCH");
    }
    stage = "BATCH_RESPONSE";
    enterWindowsParentStage(capability, stage);
    if (result.status !== 0) {
      throw new WindowsSupervisorStartupError("BATCH_RESPONSE");
    }
    stage = "POST_CHALLENGE";
    await challengeWindowsCapability(capability, "challenge", signal);
    revalidateWindowsCapabilityFiles(capability);
    stage = "BATCH_RESPONSE";
    if (result.stderr.byteLength !== 0) throw new WindowsSupervisorStartupError(stage);
    return result.stdout;
  } catch (error) {
    if (error instanceof WindowsInstalledAuthorityError) throw error;
    capability.channel.invalidate(
      error instanceof Error ? error : new WindowsSupervisorStartupError(stage),
    );
    await destroyWindowsAuthorityCapability(capability);
    throw new Error(failureMessage, {
      cause: error instanceof WindowsSupervisorStartupError ? error : new WindowsSupervisorStartupError(stage),
    });
  }
}

async function runWindowsAuthorityBatch(
  operation: "inspect" | "protect",
  kinds: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
  signal?: AbortSignal,
): Promise<{ readonly output: Buffer; readonly requestId: string }> {
  if (kinds.length === 0 || kinds.length > 64 || kinds.length !== targetFds.length) {
    throw new Error(failureMessage);
  }
  const requestId = randomUUID().replaceAll("-", "");
  const input = Buffer.from([
    "PROPR_AUTHORITY_V1", requestId, operation, String(kinds.length), ...kinds, "",
  ].join("\n"), "ascii");
  if (input.byteLength > WINDOWS_BROKER_REQUEST_MAX_BYTES) throw new Error(failureMessage);
  return {
    output: await runCachedWindowsAuthorityBroker(["batch-v1"], targetFds, failureMessage, input, undefined, signal),
    requestId,
  };
}

function enqueueWindowsAuthority<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const generation = windowsAuthorityFailureGeneration;
  const result = windowsAuthorityQueue.then(async () => {
    if (generation !== windowsAuthorityFailureGeneration) {
      throw new Error("Windows system authority capability is unavailable");
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted");
    return operation();
  });
  windowsAuthorityQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Explicit shutdown seam used by app/CLI lifecycle and native leak tests. */
export function closeWindowsAuthorityCapability(
  options: { readonly requireGracefulShutdown?: boolean } = {},
): Promise<void> {
  return enqueueWindowsAuthority(() => destroyWindowsAuthorityCapability(
    undefined,
    options.requireGracefulShutdown === true,
  ));
}

/**
 * Native-test seam which injects at a real production call site and requires
 * the exact stage to traverse the supervisor's asynchronous framed channel or
 * its production caller. No pathname, SID, source text, or raw error escapes.
 */
export function exerciseWindowsAuthorityStageFailureForNativeTest(
  requestedStage: WindowsSupervisorStage,
): Promise<WindowsAuthorityStageTestResult> {
  if (process.platform !== "win32") throw new Error("Windows stage probe requires Windows");
  if (!WINDOWS_SUPERVISOR_STAGES.has(requestedStage)) throw new Error("unknown Windows authority stage");
  return enqueueWindowsAuthority(async () => {
    await destroyWindowsAuthorityCapability();
    const fixture = mkdtempSync(join(userInfo().homedir, "propr-authority-stage-"));
    const file = join(fixture, "empty");
    let fileFd: number | undefined;
    let directoryFd: number | undefined;
    try {
      const created = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      closeSync(created);
      directoryFd = openSync(fixture, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fileFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (requestedStage === "BUILD_COMPILER" || requestedStage === "BUILD_SOURCE" || requestedStage === "BUILD_OUTPUT") {
          // BUILD_* credit comes only from the separate production build
          // subprocesses run before the successful hosted build, never from a
          // dummy file or a manually injected stage throw in this runtime.
          requireWindowsProductionBuildEvidence(requestedStage);
          throw new WindowsSupervisorStartupError(requestedStage);
        }
        if (requestedStage === "MANIFEST") {
          const helper = windowsSupervisorArtifact();
          closeSync(helper.fd);
          throw new WindowsSupervisorStartupError(requestedStage);
        }
        const revalidationStage = requestedStage === "HELPER_OPEN"
          || requestedStage === "HELPER_HASH"
          || requestedStage === "HELPER_IDENTITY";
        const capability = await acquireWindowsAuthorityCapability({
          testFailureStage: revalidationStage ? undefined : requestedStage,
        });
        if (revalidationStage) {
          capability.testFailureStage = requestedStage;
          revalidateWindowsCapabilityFiles(capability);
        } else if (requestedStage === "SHUTDOWN") {
          await runWindowsAuthorityBatch("protect", ["directory", "file"], [directoryFd, fileFd], "stage probe failed");
          await challengeWindowsCapability(capability, "stop");
        } else {
          await runWindowsAuthorityBatch("protect", ["directory", "file"], [directoryFd, fileFd], "stage probe failed");
        }
        throw new Error("Windows authority stage injection did not fire");
      } catch (error) {
        if (windowsAuthorityStageFromError(error) !== requestedStage) {
          throw new Error("Windows authority stage injection was not preserved", { cause: error });
        }
        return {
          version: 1,
          status: "failed",
          stage: requestedStage,
          publicError: "Windows system authority capability is unavailable",
        };
      }
    } finally {
      await destroyWindowsAuthorityCapability();
      if (fileFd !== undefined) closeSync(fileFd);
      if (directoryFd !== undefined) closeSync(directoryFd);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

/** Native-test proof that runtime discovery consumes only the prebuilt helper and strict manifest. */
export function exerciseWindowsHelperProvenanceForNativeTest(): {
  readonly version: 2;
  readonly protocolVersion: 2;
  readonly sourceSha256: string;
  readonly launcherSourceSha256: string;
  readonly helperSha256: string;
  readonly launcherSha256: string;
  readonly bootstrapSourceSha256: string;
  readonly bootstrapSha256: string;
  readonly trustMode: "unsigned-validation" | "production-signed";
  readonly signerPinsBound: boolean;
  readonly noRuntimeCompilerWorkspace: true;
} {
  if (process.platform !== "win32") throw new Error("Windows helper provenance probe requires Windows");
  const helper = windowsSupervisorArtifact();
  try {
    return {
      version: 2,
      protocolVersion: helper.manifest.protocolVersion,
      sourceSha256: helper.manifest.sourceSha256,
      launcherSourceSha256: helper.manifest.launcherSourceSha256,
      helperSha256: helper.digest,
      launcherSha256: helper.manifest.launcherSha256,
      bootstrapSourceSha256: helper.manifest.build.bootstrapSourceSha256,
      bootstrapSha256: helper.manifest.build.bootstrapSha256,
      trustMode: helper.manifest.trust.mode,
      signerPinsBound: helper.manifest.trust.mode === "unsigned-validation"
        ? false
        : /^[0-9a-f]{64}$/.test(helper.manifest.trust.authenticodeLeafSha256 ?? "")
          && /^[0-9a-f]{64}$/.test(helper.manifest.trust.authenticodeSpkiSha256 ?? ""),
      noRuntimeCompilerWorkspace: true,
    };
  } finally {
    closeSync(helper.fd);
  }
}

/** Native-test seam for replay, framing, EOF, and response-binding failures. */
export function exerciseWindowsAuthorityCapabilityControlForNativeTest(
  probe: {
    readonly mode:
      | "replay"
      | "wrong-request-id"
      | "wrong-identity"
      | "malformed"
      | "extra-frame"
      | "stderr"
      | "stdout-error"
      | "stdin-error"
      | "process-error"
      | "unexpected-eof"
      | "unexpected-exit"
      | "timeout"
      | "abort"
      | "partial-frame"
      | "eof"
      | "unparsed-response";
  },
): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("Windows capability control probe requires Windows");
  return enqueueWindowsAuthority(async () => {
  const capability = await acquireWindowsAuthorityCapability();
  if (probe.mode === "eof" || probe.mode === "partial-frame") {
    if (probe.mode === "partial-frame") await capability.channel.write(Buffer.from([8, 0, 0, 0, 0x7b]));
    capability.supervisor.stdin?.end();
    await destroyWindowsAuthorityCapability(capability);
    throw new Error("Windows system authority capability was malformed");
  }
  if (probe.mode === "replay") {
    try {
      const output = await exchangeWindowsCapability(capability, capability.lastRequestId, "challenge");
      void output;
    } finally {
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  if (probe.mode === "malformed") {
    const frame = encodeControlFrame({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION, kind: "challenge", requestId: randomBytes(16).toString("hex"), extra: true,
    });
    try {
      await capability.channel.exchange(JSON.parse(frame.subarray(4).toString("utf8")), WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS);
    } finally {
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  const requestId = randomBytes(16).toString("hex");
  if ([
    "extra-frame", "stderr", "stdout-error", "stdin-error", "process-error",
    "unexpected-eof", "unexpected-exit", "timeout", "abort",
  ].includes(probe.mode)) {
    const controller = new AbortController();
    capability.channel.installSettlingProbeForNativeTest((pending) => {
      const streamError = new Error("Windows authority settling probe");
      switch (probe.mode) {
        case "extra-frame": {
          const extra = encodeControlFrame({
            version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
            kind: "ready",
            requestId: randomBytes(16).toString("hex"),
          });
          capability.supervisor.stdout!.emit("data", extra.subarray(0, 1));
          capability.supervisor.stdout!.emit("data", extra.subarray(1));
          break;
        }
        case "stderr": capability.supervisor.stderr!.emit("data", Buffer.from("x")); break;
        case "stdout-error": capability.supervisor.stdout!.emit("error", streamError); break;
        case "stdin-error": capability.supervisor.stdin!.emit("error", streamError); break;
        case "process-error": capability.supervisor.emit("error", streamError); break;
        case "unexpected-eof": capability.supervisor.stdout!.emit("end"); break;
        case "unexpected-exit": capability.supervisor.emit("exit", 1, null); break;
        case "timeout": pending.onTimeout?.(); break;
        case "abort": controller.abort(new Error("Windows authority request aborted")); break;
      }
    });
    try {
      return await exchangeWindowsCapability(
        capability,
        requestId,
        "challenge",
        WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS,
        controller.signal,
      );
    } finally {
      const invalidationClass = capability.channel.invalidationClassForNativeTest();
      await destroyWindowsAuthorityCapability(capability);
      if (!invalidationClass) throw new Error("Windows settling invalidation probe did not fire");
    }
  }
  const output = await exchangeWindowsCapability(capability, requestId, "challenge");
  if (probe.mode === "unparsed-response") {
    await destroyWindowsAuthorityCapability(capability);
    return output;
  }
  if (probe.mode === "wrong-request-id" || probe.mode === "wrong-identity") {
    const heldIdentity = capability.heldIdentity;
    try {
      if (probe.mode === "wrong-identity" && heldIdentity) {
        capability.heldIdentity = {
          volumeSerialNumber: heldIdentity.volumeSerialNumber,
          fileId: heldIdentity.fileId === "0" ? "1" : "0",
        };
      }
      validateWindowsCapabilityResponse(
        capability,
        "challenge",
        probe.mode === "wrong-request-id" ? randomBytes(16).toString("hex") : requestId,
        output,
      );
    } finally {
      capability.heldIdentity = heldIdentity;
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  return output;
  });
}

/** Native-test seam for locked-image, serialization, restart, and cleanup evidence. */
export function exerciseWindowsAuthorityCapabilityForNativeTest(
  probe: WindowsAuthorityCapabilityProbe = {},
): Promise<{
  readonly output: Buffer;
  readonly stagedPath: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly authorityPid: number;
  readonly stage: "READY";
}> {
  if (process.platform !== "win32") throw new Error("Windows capability probe requires Windows");
  return enqueueWindowsAuthority(async () => {
  if (probe.onStaged || probe.onPackagedBrokerLocked || probe.onBootstrapFirstLaunch || probe.onBootstrapCreateProcess || probe.onOuterAuthorityCreateProcess || probe.onInstalledAuthorityAuthorized || probe.onSupervisorStarting || probe.onSupervisorSpawned) {
    await destroyWindowsAuthorityCapability();
  }
  const capability = await acquireWindowsAuthorityCapability(
    probe.onStaged || probe.onPackagedBrokerLocked || probe.onBootstrapFirstLaunch || probe.onBootstrapCreateProcess || probe.onOuterAuthorityCreateProcess || probe.onInstalledAuthorityAuthorized || probe.onSupervisorStarting || probe.onSupervisorSpawned
      ? probe
      : undefined,
    probe.signal,
  );
  if (!capability.supervisor.pid) throw new Error("Windows capability probe is unavailable");
  const output = await runCachedWindowsAuthorityBroker(
    probe.args ?? ["ping"],
    [],
    "Windows capability probe is unavailable",
    undefined,
    probe.onRequestLocked,
    probe.signal,
  );
  return {
    output,
    stagedPath: capability.staged.path,
    directory: capability.staged.directory,
    supervisorPid: capability.supervisor.pid,
    authorityPid: Number(capability.authorityPid),
    stage: "READY",
  };
  }, probe.signal);
}

function nativeDarwinAcl(
  _path: string,
  pinnedFd: number,
  _expectedIdentity: StableAuthorityIdentity,
): DarwinAuthorityInspection {
  if (!Number.isInteger(pinnedFd) || pinnedFd < 0) throw new Error("Darwin ACL authority inspection is unavailable");
  const artifact = authorityBrokerArtifact("darwin", process.arch);
  let capability: ReturnType<typeof stageDarwinAuthorityBroker>;
  try {
    capability = stageDarwinAuthorityBroker(artifact);
  } catch (error) {
    closeSync(artifact.fd);
    throw error;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(capability.path, [], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      env: {},
      timeout: 5000,
      maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
      // fd 3 is the caller's already-held object. The broker uses only fstat and
      // acl_get_fd_np/acl_to_text on this inherited descriptor.
      stdio: ["ignore", "pipe", "pipe", pinnedFd],
    });
    const staged = fstatSync(capability.fd, { bigint: true });
    if (
      !staged.isFile()
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(capability.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) throw new Error("packaged native authority broker was replaced");
    revalidateAuthorityBroker(artifact);
  } finally {
    closeSync(capability.fd);
    rmSync(capability.directory, { recursive: true, force: true });
    closeSync(artifact.fd);
  }
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Darwin ACL authority inspection is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(result.stdout).trim());
  } catch {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  assertDarwinInspectionShape(parsed);
  return parsed;
}

function validateWindowsBrokerPath(path: string): void {
  if (!path || path.includes("\0") || path.length > 32_000) {
    throw new Error("Windows system authority inspection is unavailable");
  }
}

async function nativeWindowsAcls(entries: readonly WindowsAuthorityTarget[]): Promise<readonly WindowsAuthorityInspection[]> {
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("Windows ACL authority inspection is unavailable");
  }
  for (const entry of entries) {
    if (!Number.isInteger(entry.pinnedFd) || entry.pinnedFd < 0) {
      throw new Error("Windows ACL authority inspection is unavailable");
    }
  }
  // Read-only discovery must not bootstrap the installed launch authority.
  // It invokes only the checksum-bound inspection mode and passes the exact
  // already-open objects as inherited handles. Mutation/protection and the
  // persistent privileged launch chain continue through the installed
  // authority below.
  const helper = windowsSupervisorArtifact();
  const artifact = authorityBrokerArtifact("win32", "x64", helper.manifest.launcherSha256);
  const requestId = randomUUID().replaceAll("-", "");
  const input = Buffer.from([
    "PROPR_AUTHORITY_V1", requestId, "inspect", String(entries.length),
    ...entries.map((entry) => entry.kind), "",
  ].join("\n"), "ascii");
  let result: BoundedChildResult;
  try {
    result = await runBoundedWindowsChild(
      artifact.path,
      ["batch-v1"],
      entries.map((entry) => entry.pinnedFd),
      input,
    );
    revalidateAuthorityBroker(artifact);
    if (result.status !== 0 || result.stderr.byteLength !== 0) {
      throw new Error("Windows ACL authority inspection is unavailable");
    }
  } finally {
    closeSync(artifact.fd);
    closeSync(helper.fd);
  }
  const batch = { output: result.stdout, requestId };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(batch.output).trim());
  } catch {
    throw new Error("Windows ACL authority inspection was malformed");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, ["version", "requestId", "entries"])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== 1
    || document.requestId !== batch.requestId
    || !Array.isArray(document.entries)
    || document.entries.length !== entries.length
  ) {
    throw new Error("Windows ACL authority inspection was malformed");
  }
  for (let index = 0; index < document.entries.length; index += 1) {
    const inspection = document.entries[index];
    assertWindowsInspectionShape(inspection);
    const target = entries[index];
    if (
      inspection.index !== index
      || inspection.authorityKind !== target.kind
      || inspection.kind !== (target.kind === "env" ? "file" : "directory")
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows ACL authority inspection was malformed");
  }
  return document.entries;
}

async function nativeWindowsAcl(
  path: string,
  expectedIdentity: StableAuthorityIdentity,
  pinnedFd?: number,
  kind: ConnectAuthorityEntryKind = "env",
): Promise<WindowsAuthorityInspection> {
  if (pinnedFd === undefined) throw new Error("Windows ACL authority inspection is unavailable");
  return (await nativeWindowsAcls([{ path, kind, expectedIdentity, pinnedFd }]))[0];
}

/** Establish the same narrowly documented DACL used by a new Windows stack. */
export async function protectWindowsSetupEntry(path: string, kind: "directory" | "file"): Promise<void> {
  await protectWindowsSetupEntries([{ path, kind }]);
}

/** Protect a complete setup group in one bounded native broker process. */
export async function protectWindowsSetupEntries(
  entries: readonly { readonly path: string; readonly kind: "directory" | "file" }[],
): Promise<void> {
  if (process.platform !== "win32" || entries.length === 0) return;
  if (entries.length > 64) throw new Error("Windows setup authority could not be established");
  for (const entry of entries) {
    validateWindowsBrokerPath(entry.path);
  }
  const held: number[] = [];
  const identities: StableAuthorityIdentity[] = [];
  try {
    for (const entry of entries) {
      const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW
        | (entry.kind === "directory" ? constants.O_DIRECTORY : 0));
      const pinned = fstatSync(fd, { bigint: true });
      const named = lstatSync(entry.path, { bigint: true });
      if (
        named.isSymbolicLink()
        || pinned.dev !== named.dev
        || pinned.ino !== named.ino
        || (entry.kind === "directory") !== pinned.isDirectory()
      ) {
        closeSync(fd);
        throw new Error("Windows setup authority could not be established");
      }
      held.push(fd);
      identities.push(stableAuthorityIdentity(fd));
    }
    const batch = await enqueueWindowsAuthority(() => runWindowsAuthorityBatch(
      "protect",
      entries.map((entry) => entry.kind),
      held,
      "Windows setup authority could not be established",
    ));
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBoundedUtf8(batch.output).trim());
    } catch {
      throw new Error("Windows setup authority could not be established");
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || !exactKeys(parsed, ["version", "requestId", "protected", "entries"])
    ) throw new Error("Windows setup authority could not be established");
    const document = parsed as Record<string, unknown>;
    if (
      document.version !== 1
      || document.requestId !== batch.requestId
      || document.protected !== entries.length
      || !Array.isArray(document.entries)
      || document.entries.length !== entries.length
    ) throw new Error("Windows setup authority could not be established");
    for (let index = 0; index < entries.length; index += 1) {
      const inspection = document.entries[index];
      assertWindowsInspectionShape(inspection);
      const kind = entries[index].kind === "directory" ? "root" : "env";
      if (
        inspection.index !== index
        || inspection.authorityKind !== kind
        || inspection.kind !== entries[index].kind
        || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
        || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
      ) throw new Error("Windows setup authority could not be established");
      assertSafeWindowsAuthority(inspection, kind);
      const after = stableAuthorityIdentity(held[index]);
      if (after.device !== identities[index].device || after.file !== identities[index].file) {
        throw new Error("Windows setup authority could not be established");
      }
    }
  } catch (error) {
    throw new Error("Windows setup authority could not be established", { cause: error });
  } finally {
    for (const fd of held) closeSync(fd);
  }
}

export const nativeConnectRootAuthorityInspector: ConnectRootAuthorityInspector = {
  inspectDarwinAcl: nativeDarwinAcl,
  inspectWindowsAcl: nativeWindowsAcl,
  inspectWindowsAcls: nativeWindowsAcls,
};

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonicalUint64(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,19})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffn;
}

function assertDarwinInspectionShape(value: unknown): asserts value is DarwinAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["version", "device", "file", "acl"])
  ) throw new Error("Darwin ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || !canonicalUint64(record.device)
    || !canonicalUint64(record.file)
    || typeof record.acl !== "string"
    || Buffer.byteLength(record.acl, "utf8") > 24 * 1024
  ) throw new Error("Darwin ACL authority inspection was malformed");
}

function assertWindowsInspectionShape(value: unknown): asserts value is WindowsAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, [
      "index", "kind", "authorityKind", "currentUserSid", "ownerSid", "daclProtected", "reparsePoint",
      "volumeSerialNumber", "fileId", "verifiedVolumeSerialNumber", "verifiedFileId", "rules",
    ])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.index)
    || (record.index as number) < 0
    || (record.index as number) >= 64
    || (record.kind !== "directory" && record.kind !== "file")
    || !["ancestor", "home", "root", "data", "env"].includes(record.authorityKind as string)
    || typeof record.currentUserSid !== "string"
    || !WINDOWS_SID.test(record.currentUserSid)
    || typeof record.ownerSid !== "string"
    || !WINDOWS_SID.test(record.ownerSid)
    || typeof record.daclProtected !== "boolean"
    || typeof record.reparsePoint !== "boolean"
    || typeof record.volumeSerialNumber !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.volumeSerialNumber)
    || typeof record.fileId !== "string"
    || !/^(?:0|[1-9]\d{0,38})$/.test(record.fileId)
    || BigInt(record.fileId) > 0xffffffffffffffffffffffffffffffffn
    || typeof record.verifiedVolumeSerialNumber !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.verifiedVolumeSerialNumber)
    || BigInt(record.verifiedVolumeSerialNumber) > 0xffffffffffffffffn
    || typeof record.verifiedFileId !== "string"
    || !/^(?:0|[1-9]\d{0,38})$/.test(record.verifiedFileId)
    || BigInt(record.verifiedFileId) > 0xffffffffffffffffffffffffffffffffn
    || !Array.isArray(record.rules)
    || record.rules.length > 256
  ) throw new Error("Windows ACL authority inspection was malformed");
  for (const rule of record.rules) {
    if (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || !exactKeys(rule, ["identitySid", "inherited", "accessType", "appliesToSelf", "rights"])
    ) throw new Error("Windows ACL authority inspection was malformed");
    const item = rule as Record<string, unknown>;
    if (
      typeof item.identitySid !== "string"
      || !WINDOWS_SID.test(item.identitySid)
      || typeof item.inherited !== "boolean"
      || (item.accessType !== "allow" && item.accessType !== "deny")
      || typeof item.appliesToSelf !== "boolean"
      || typeof item.rights !== "string"
      || !/^(?:0|[1-9]\d{0,9})$/.test(item.rights)
      || BigInt(item.rights) > 0xffffffffn
    ) throw new Error("Windows ACL authority inspection was malformed");
  }
}

/** Apply the same fail-closed policy to native results and deterministic fixtures. */
export function assertSafeWindowsAuthority(
  inspection: WindowsAuthorityInspection,
  kind: ConnectAuthorityEntryKind,
): void {
  assertWindowsInspectionShape(inspection);
  const trustedOwners = new Set([inspection.currentUserSid, ...WINDOWS_TRUSTED_MUTATORS]);
  const terminal = kind !== "ancestor";
  const protectedTerminal = kind !== "ancestor" && kind !== "home";
  if (
    (terminal && inspection.ownerSid !== inspection.currentUserSid)
    || (!terminal && !trustedOwners.has(inspection.ownerSid))
  ) throw new WindowsAuthorityPolicyError(inspection.index, "OWNER_MISMATCH");
  if (inspection.reparsePoint) {
    throw new WindowsAuthorityPolicyError(inspection.index, "REPARSE_POINT");
  }

  for (const rule of inspection.rules) {
    if (rule.accessType !== "allow" || !rule.appliesToSelf) continue;
    const rights = BigInt(rule.rights);
    if ((rights & ~WINDOWS_KNOWN_ALLOW_RIGHTS) !== 0n) {
      throw new WindowsAuthorityPolicyError(inspection.index, "UNKNOWN_RIGHTS");
    }
    const mutates = (rights & (WINDOWS_MUTATING_RIGHTS | WINDOWS_GENERIC_MUTATING_RIGHTS)) !== 0n;
    if (!mutates) continue;
    // OS ancestry commonly inherits grants for the same narrowly trusted
    // user/SYSTEM/Administrators set. Terminal setup/config entries must be
    // protected and explicit; an ancestor may inherit only those principals.
    if (!trustedOwners.has(rule.identitySid)) {
      throw new WindowsAuthorityPolicyError(inspection.index, "BROAD_WRITE");
    }
    if (protectedTerminal && rule.inherited) {
      throw new WindowsAuthorityPolicyError(inspection.index, "INHERITED_WRITE");
    }
  }
  if (protectedTerminal && !inspection.daclProtected) {
    throw new WindowsAuthorityPolicyError(inspection.index, "DACL_NOT_PROTECTED");
  }
}

const DARWIN_READ_ONLY_ACL_PERMISSIONS = new Set([
  "execute",
  "list",
  "read",
  "readattr",
  "readextattr",
  "readsecurity",
  "search",
  "synchronize",
]);
const DARWIN_MUTATING_ACL_PERMISSIONS = new Set([
  "add_file",
  "add_subdirectory",
  "append",
  "chown",
  "delete",
  "delete_child",
  "write",
  "writeattr",
  "writeextattr",
  "writesecurity",
]);
const DARWIN_ACL_FLAGS = new Set(["directory_inherit", "file_inherit", "inherited", "limit_inherit", "only_inherit"]);

/** Reject malformed ACL output and every ACL allow entry carrying mutation authority. */
export function assertSafeDarwinAclOutput(output: string): void {
  if (!output || Buffer.byteLength(output, "utf8") > 24 * 1024 || output.includes("\0")) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  const lines = output.replace(/\n$/, "").split("\n");
  if (!/^!#acl 1(?: (?:defer_inherit|no_inherit)(?:,(?:defer_inherit|no_inherit))*)?$/.test(lines[0])) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  for (const line of lines.slice(1)) {
    const fields = line.split(":");
    if (
      fields.length !== 6
      || (fields[0] !== "user" && fields[0] !== "group")
      || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(fields[1])
      || fields[2].length > 255
      || !/^(?:|0|[1-9]\d{0,9})$/.test(fields[3])
    ) throw new Error("Darwin ACL authority inspection was malformed");
    const disposition = fields[4].split(",");
    if (disposition[0] !== "allow" && disposition[0] !== "deny") {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    if (disposition.slice(1).some((flag) => !DARWIN_ACL_FLAGS.has(flag))) {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    const permissions = fields[5].split(",");
    for (const permission of permissions) {
      if (disposition[0] === "allow" && DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL grants unexpected write authority");
      }
      if (!DARWIN_READ_ONLY_ACL_PERMISSIONS.has(permission) && !DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL authority inspection was malformed");
      }
    }
  }
}

export async function assertNativeEntryAuthority(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
  pinnedFd: number,
): Promise<void> {
  const before = stableAuthorityIdentity(pinnedFd);
  if (platform === "darwin") {
    const inspection = inspector.inspectDarwinAcl(path, pinnedFd, before);
    assertDarwinInspectionShape(inspection);
    if (inspection.device !== before.device || inspection.file !== before.file) {
      throw new Error("Darwin authority inspection did not match the pinned object");
    }
    assertSafeDarwinAclOutput(inspection.acl);
  } else if (platform === "win32") {
    const inspection = await inspector.inspectWindowsAcl(path, before, pinnedFd, kind);
    assertWindowsInspectionShape(inspection);
    if (
      inspection.index !== 0
      || inspection.authorityKind !== kind
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows authority inspection did not match the pinned object");
    assertSafeWindowsAuthority(inspection, kind);
  }
  const after = stableAuthorityIdentity(pinnedFd);
  if (before.device !== after.device || before.file !== after.file) {
    throw new Error("native authority target changed during inspection");
  }
}

/** Inspect all Windows entries in one process and bind every result to its held descriptor identity. */
export async function assertNativeWindowsEntriesAuthority(
  inspector: ConnectRootAuthorityInspector,
  entries: readonly { path: string; kind: ConnectAuthorityEntryKind; pinnedFd: number }[],
): Promise<void> {
  const targets = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    expectedIdentity: stableAuthorityIdentity(entry.pinnedFd),
    pinnedFd: entry.pinnedFd,
  }));
  const batched = inspector.inspectWindowsAcls !== undefined;
  const inspections = inspector.inspectWindowsAcls
    ? await inspector.inspectWindowsAcls(targets)
    : await Promise.all(targets.map((target) => inspector.inspectWindowsAcl(
      target.path, target.expectedIdentity, target.pinnedFd, target.kind,
    )));
  if (inspections.length !== targets.length) throw new Error("Windows ACL authority inspection was malformed");
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const inspection = inspections[index];
    assertWindowsInspectionShape(inspection);
    if (
      inspection.index !== (batched ? index : 0)
      || inspection.authorityKind !== target.kind
      || inspection.kind !== (target.kind === "env" ? "file" : "directory")
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows authority inspection did not match the pinned object");
    assertSafeWindowsAuthority(inspection, target.kind);
    const after = stableAuthorityIdentity(entries[index].pinnedFd);
    if (after.device !== target.expectedIdentity.device || after.file !== target.expectedIdentity.file) {
      throw new Error("native authority target changed during inspection");
    }
  }
}
