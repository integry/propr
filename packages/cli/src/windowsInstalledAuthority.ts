import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export const WINDOWS_CONNECT_AUTHORITY_PIPE = String.raw`\\.\pipe\ProPR.Connect.Authority.v3`;
export const WINDOWS_CONNECT_AUTHORITY_VERSION = "3.0.0";
const MAX_FRAME = 4096;
const TIMEOUT_MS = 8_000;

export class WindowsInstalledAuthorityError extends Error {
  readonly code: "ABSENT" | "VERSION" | "AUTHORITY" | "PROTOCOL" | "TIMEOUT";
  readonly state: "authorityMissing" | "repairRequired";
  constructor(code: WindowsInstalledAuthorityError["code"]) {
    const action = code === "ABSENT"
      ? "Install or repair ProPR Connect Authority from the signed Windows Installer package, then retry."
      : code === "VERSION"
        ? "Repair or upgrade ProPR Connect Authority so its version matches this CLI, then retry."
        : "Repair ProPR Connect Authority from the signed Windows Installer package, then retry.";
    super(`Windows Connect authority is unavailable [reason=${code}]. ${action}`);
    this.name = "WindowsInstalledAuthorityError";
    this.code = code;
    this.state = code === "ABSENT" ? "authorityMissing" : "repairRequired";
  }
}

export interface InstalledAuthorityIdentity {
  readonly serviceVersion: string;
  readonly imagePath?: string;
  readonly volumeSerialNumber?: string;
  readonly fileId?: string;
  readonly sha256: string;
  readonly authenticodeLeafSha256: string;
  readonly authenticodeSpkiSha256: string;
}

export interface WindowsInstalledAuthoritySession {
  exchange(document: unknown): Promise<unknown>;
  close(): void;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalUint(value: unknown, bits: 32 | 64 | 128): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return false;
  try { const parsed = BigInt(value); return parsed >= 0n && parsed < (1n << BigInt(bits)); } catch { return false; }
}

function canonicalServiceSid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("-");
  return parts.length === 9 && parts.slice(0, 4).join("-") === "S-1-5-80"
    && parts.slice(4).every((part) => canonicalUint(part, 32));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function frame(document: unknown): Buffer {
  const body = Buffer.from(canonicalJson(document), "utf8");
  if (body.byteLength < 2 || body.byteLength > MAX_FRAME) throw new WindowsInstalledAuthorityError("PROTOCOL");
  const output = Buffer.allocUnsafe(body.byteLength + 4);
  output.writeUInt32LE(body.byteLength, 0);
  body.copy(output, 4);
  return output;
}

class PipeSession implements WindowsInstalledAuthoritySession {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly destroyChannel: () => void;
  private pending = Buffer.alloc(0);
  constructor(readable: Readable, writable: Writable, destroyChannel: () => void) {
    this.readable = readable;
    this.writable = writable;
    this.destroyChannel = destroyChannel;
    // Child stdin and stdout are distinct streams. Keep an error listener on
    // stdin for the lifetime of the proxy so a verifier rejection cannot turn
    // a later EPIPE into an unhandled process error.
    this.writable.on("error", () => { this.readable.destroy(); });
  }
  exchange(document: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readable.off("data", onData);
        this.readable.off("error", onError);
        this.readable.off("close", onClose);
        if (error) reject(error); else resolve(value);
      };
      const onError = () => finish(new WindowsInstalledAuthorityError("AUTHORITY"));
      const onClose = () => finish(new WindowsInstalledAuthorityError("AUTHORITY"));
      const onData = (chunk: Buffer) => {
        this.pending = Buffer.concat([this.pending, chunk]);
        if (this.pending.byteLength > MAX_FRAME + 4) return finish(new WindowsInstalledAuthorityError("PROTOCOL"));
        if (this.pending.byteLength < 4) return;
        const length = this.pending.readUInt32LE(0);
        if (length < 2 || length > MAX_FRAME || this.pending.byteLength !== length + 4) {
          if (this.pending.byteLength >= length + 4) finish(new WindowsInstalledAuthorityError("PROTOCOL"));
          return;
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(this.pending.subarray(4));
          const parsed = JSON.parse(text) as unknown;
          if (canonicalJson(parsed) !== text) throw new Error("noncanonical");
          this.pending = Buffer.alloc(0);
          finish(undefined, parsed);
        } catch { finish(new WindowsInstalledAuthorityError("PROTOCOL")); }
      };
      const timer = setTimeout(() => finish(new WindowsInstalledAuthorityError("TIMEOUT")), TIMEOUT_MS);
      this.readable.on("data", onData);
      this.readable.once("error", onError);
      this.readable.once("close", onClose);
      try { this.writable.write(frame(document)); }
      catch { finish(new WindowsInstalledAuthorityError("AUTHORITY")); }
    });
  }
  close(): void { this.destroyChannel(); }
}

async function connectPipe(expected: InstalledAuthorityIdentity): Promise<WindowsInstalledAuthoritySession> {
  const imagePath = expected.imagePath
    ?? String.raw`C:\Program Files\ProPR Connect Authority\ProPRConnectAuthority.exe`;
  const child = spawn(imagePath, ["--client-proxy-v3"], {
    shell: false,
    windowsHide: true,
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
  });
  let spawnError = false;
  child.once("error", () => { spawnError = true; });
  if (!child.stdin || !child.stdout) throw new WindowsInstalledAuthorityError("ABSENT");
  const session = new PipeSession(child.stdout, child.stdin, () => {
    child.stdin?.destroy(); child.stdout?.destroy(); child.kill();
  });
  const requestId = randomUUID().replaceAll("-", "");
  const nonce = randomBytes(32).toString("hex");
  let ready: unknown;
  try {
    ready = await session.exchange({
      version: 3, kind: "proxy-open", requestId, nonce,
      serviceVersion: expected.serviceVersion,
      imagePath,
      sha256: expected.sha256,
      authenticodeLeafSha256: expected.authenticodeLeafSha256,
      authenticodeSpkiSha256: expected.authenticodeSpkiSha256,
    });
  } catch (error) {
    session.close();
    if (spawnError || (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new WindowsInstalledAuthorityError("ABSENT");
    }
    throw error;
  }
  if (!ready || typeof ready !== "object" || Array.isArray(ready)
    || !exactKeys(ready, ["version", "kind", "requestId", "nonce", "serverPid", "imagePath",
      "volumeSerialNumber", "fileId", "sha256", "accountSid", "serviceSid", "daclProtected", "verified"])
    || (ready as Record<string, unknown>).version !== 3
    || (ready as Record<string, unknown>).kind !== "proxy-ready"
    || (ready as Record<string, unknown>).requestId !== requestId
    || (ready as Record<string, unknown>).nonce !== nonce
    || (ready as Record<string, unknown>).verified !== true
    || (ready as Record<string, unknown>).accountSid !== "S-1-5-18"
    || !canonicalServiceSid((ready as Record<string, unknown>).serviceSid)
    || (ready as Record<string, unknown>).daclProtected !== true
    || String((ready as Record<string, unknown>).imagePath).toLowerCase() !== imagePath.toLowerCase()
    || (ready as Record<string, unknown>).sha256 !== expected.sha256
    || !canonicalUint((ready as Record<string, unknown>).serverPid, 32)
    || !canonicalUint((ready as Record<string, unknown>).volumeSerialNumber, 64)
    || !canonicalUint((ready as Record<string, unknown>).fileId, 128)) {
    session.close();
    throw new WindowsInstalledAuthorityError("AUTHORITY");
  }
  return session;
}

export interface InstalledWindowsLaunchLease {
  readonly servicePid: number;
  readonly identity: Readonly<{
    imagePath: string; volumeSerialNumber: string; fileId: string; sha256: string;
    authenticodeLeafSha256: string; authenticodeSpkiSha256: string;
  }>;
  confirm(childPid: number): Promise<void>;
  release(): Promise<void>;
}

export async function acquireInstalledWindowsLaunchLease(
  artifact: { readonly path: string; readonly sha256: string },
  expected: InstalledAuthorityIdentity,
  options: { readonly session?: WindowsInstalledAuthoritySession; readonly nonce?: string; readonly requestId?: string } = {},
): Promise<InstalledWindowsLaunchLease> {
  const session = options.session ?? await connectPipe(expected);
  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  const requestId = options.requestId ?? randomUUID().replaceAll("-", "");
  const request = {
    version: 3, kind: "authorize-launch", requestId, nonce,
    serviceVersion: WINDOWS_CONNECT_AUTHORITY_VERSION,
    artifactPath: artifact.path, artifactSha256: artifact.sha256,
  };
  if (!/^[0-9a-f]{64}$/u.test(nonce) || !/^[0-9a-f]{32}$/u.test(requestId)
    || !/^[0-9a-f]{64}$/u.test(artifact.sha256) || artifact.path.length < 3 || artifact.path.length > 1024
    || /[\0\r\n]/u.test(artifact.path)) throw new WindowsInstalledAuthorityError("PROTOCOL");
  const requestDigest = createHash("sha256").update(canonicalJson(request)).digest("hex");
  let response: unknown;
  try { response = await session.exchange(request); }
  catch (error) { session.close(); throw error; }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    session.close(); throw new WindowsInstalledAuthorityError("PROTOCOL");
  }
  const receipt = response as Record<string, unknown>;
  if (receipt.serviceVersion !== WINDOWS_CONNECT_AUTHORITY_VERSION) {
    session.close(); throw new WindowsInstalledAuthorityError("VERSION");
  }
  if (!exactKeys(receipt, ["version", "kind", "requestId", "nonce", "requestDigest", "hook", "leaseId",
    "serviceVersion", "serverPid", "pipeServerPid", "imagePath", "volumeSerialNumber", "fileId", "sha256",
    "authenticodeLeafSha256", "authenticodeSpkiSha256", "accountSid", "daclProtected", "replayed"])
    || receipt.version !== 3 || receipt.kind !== "launch-authorized" || receipt.requestId !== requestId
    || receipt.nonce !== nonce || receipt.requestDigest !== requestDigest
    || receipt.hook !== "windows-service.before-package-createprocess-v1"
    || !/^[0-9a-f]{32}$/u.test(String(receipt.leaseId))
    || !canonicalUint(receipt.serverPid, 32) || receipt.serverPid !== receipt.pipeServerPid
    || typeof receipt.imagePath !== "string"
    || !/^[A-Za-z]:\\Program Files\\ProPR Connect Authority\\ProPRConnectAuthority\.exe$/iu.test(receipt.imagePath)
    || !/^[0-9a-f]{64}$/u.test(String(receipt.sha256))
    || !/^[0-9a-f]{64}$/u.test(String(receipt.authenticodeLeafSha256))
    || !/^[0-9a-f]{64}$/u.test(String(receipt.authenticodeSpkiSha256))
    || (expected.imagePath !== undefined && receipt.imagePath !== expected.imagePath)
    || (expected.volumeSerialNumber !== undefined && receipt.volumeSerialNumber !== expected.volumeSerialNumber)
    || (expected.fileId !== undefined && receipt.fileId !== expected.fileId) || receipt.sha256 !== expected.sha256
    || receipt.authenticodeLeafSha256 !== expected.authenticodeLeafSha256
    || receipt.authenticodeSpkiSha256 !== expected.authenticodeSpkiSha256
    || receipt.accountSid !== "S-1-5-18" || receipt.daclProtected !== true || receipt.replayed !== false
    || !canonicalUint(receipt.volumeSerialNumber, 64) || !canonicalUint(receipt.fileId, 128)) {
    session.close(); throw new WindowsInstalledAuthorityError("AUTHORITY");
  }
  let active = true;
  const exchangeControl = async (kind: "confirm-launch" | "release-launch", childPid?: number) => {
    if (!active) throw new WindowsInstalledAuthorityError("AUTHORITY");
    const controlNonce = randomBytes(32).toString("hex");
    const control = { version: 3, kind, requestId: randomUUID().replaceAll("-", ""), nonce: controlNonce,
      leaseId: receipt.leaseId, ...(childPid === undefined ? {} : { childPid: String(childPid) }) };
    const answer = await session.exchange(control) as Record<string, unknown>;
    if (!answer || typeof answer !== "object" || Array.isArray(answer)
      || !exactKeys(answer, ["version", "kind", "requestId", "nonce", "leaseId", "verified"])
      || answer.version !== 3 || answer.kind !== `${kind}-receipt` || answer.requestId !== control.requestId
      || answer.nonce !== controlNonce || answer.leaseId !== receipt.leaseId || answer.verified !== true) {
      throw new WindowsInstalledAuthorityError("AUTHORITY");
    }
  };
  return {
    servicePid: Number(receipt.serverPid),
    identity: Object.freeze({
      imagePath: receipt.imagePath as string,
      volumeSerialNumber: receipt.volumeSerialNumber as string,
      fileId: receipt.fileId as string,
      sha256: receipt.sha256 as string,
      authenticodeLeafSha256: receipt.authenticodeLeafSha256 as string,
      authenticodeSpkiSha256: receipt.authenticodeSpkiSha256 as string,
    }),
    async confirm(childPid) {
      if (!Number.isSafeInteger(childPid) || childPid < 1) throw new WindowsInstalledAuthorityError("PROTOCOL");
      await exchangeControl("confirm-launch", childPid);
    },
    async release() {
      if (!active) return;
      try { await exchangeControl("release-launch"); }
      finally { active = false; session.close(); }
    },
  };
}
