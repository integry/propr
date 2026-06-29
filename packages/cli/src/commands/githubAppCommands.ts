/**
 * GitHub App helper commands.
 *
 * Generates a ready-to-submit GitHub App manifest and a matching `.env`
 * snippet so self-hosters can run ProPR with their own GitHub App in
 * `GITHUB_EVENT_INTAKE_MODE=direct_webhook` mode without hand-assembling
 * permissions, webhook events, and a webhook secret.
 */

import { Command } from "commander";
import crypto from "crypto";
import path from "path";
import { writeFile, mkdir, access } from "fs/promises";
import { printOutput } from "../utils/io.js";
import { MANIFEST_FILENAME, ENV_FILENAME } from "./githubAppManifestFiles.js";

// Re-exported so existing importers (and tests) can keep sourcing the filenames
// from this module; the canonical definitions live in the dependency-free
// shared module so the setup engine can import them without commander.
export { MANIFEST_FILENAME, ENV_FILENAME };

/**
 * Repository permissions ProPR requires to implement issues, push branches,
 * open pull requests, and read CI status. Kept here as the single source of
 * truth for the generated manifest.
 */
export const PROPR_APP_PERMISSIONS: Record<string, string> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "read",
  // Required to receive (and act on) the `check_run` and `status` webhook
  // events declared below. GitHub ties event delivery to app permissions.
  checks: "read",
  statuses: "read",
};

/**
 * Webhook events ProPR's core webhook handler understands. Mirrors
 * SUPPORTED_WEBHOOK_EVENTS in @propr/core (the CLI does not depend on core,
 * so the list is duplicated intentionally and kept in sync).
 */
export const PROPR_WEBHOOK_EVENTS: string[] = [
  "issues",
  "issue_comment",
  "pull_request_review_comment",
  "pull_request",
  "check_run",
  "push",
  "status",
];

export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: {
    url: string;
    active: boolean;
    secret: string;
  };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface GenerateManifestOptions {
  /** Output directory for the manifest + env files. Defaults to process.cwd(). */
  root?: string;
  /** Public base URL where GitHub can reach this ProPR install (required). */
  publicUrl: string;
  /** Override the webhook delivery URL. Defaults to `<publicUrl>/webhook`. */
  webhookUrl?: string;
  /** GitHub App name shown in the manifest. Defaults to "ProPR". */
  name?: string;
  /** Webhook secret. A cryptographically strong one is generated when omitted. */
  webhookSecret?: string;
  /**
   * Organization login to scope App creation to. When set, the returned
   * create URL points at the org's App-creation page instead of the
   * personal-account one.
   */
  org?: string;
  /** Overwrite existing output files. */
  force?: boolean;
}

export interface GenerateManifestResult {
  directory: string;
  manifestPath: string;
  envPath: string;
  publicUrl: string;
  webhookUrl: string;
  webhookSecret: string;
  manifest: GithubAppManifest;
  /** GitHub URL where the user submits the manifest to create the App. */
  createUrl: string;
}

/** Generate a cryptographically strong webhook secret (64 hex chars). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Strip trailing slashes so URL joins do not produce `//`. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Validate that a value is an absolute http(s) URL, returning the trimmed
 * string. Throws (referencing `flag`) on anything else.
 */
function validateHttpUrl(value: string, flag: string): string {
  const raw = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${flag}: "${raw}" is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${flag}: "${raw}" must use http:// or https://`);
  }

  return raw;
}

/**
 * Validate and normalize the public base URL. Throws on anything that is not
 * an absolute http(s) URL.
 */
function resolvePublicUrl(publicUrl: string | undefined): string {
  const raw = (publicUrl ?? "").trim();
  if (!raw) {
    throw new Error(
      "A public base URL is required. Pass --public-url https://propr.example.com"
    );
  }

  return normalizeBaseUrl(validateHttpUrl(raw, "--public-url"));
}

/**
 * Resolve the webhook delivery URL. Defaults to `<publicUrl>/webhook`; a custom
 * override receives the same absolute http(s) validation as the public URL.
 */
function resolveWebhookUrl(
  webhookUrl: string | undefined,
  publicUrl: string
): string {
  const raw = (webhookUrl ?? "").trim();
  if (!raw) {
    return `${publicUrl}/webhook`;
  }
  return validateHttpUrl(raw, "--webhook-url");
}

/**
 * Build the GitHub URL where the user submits the manifest to create the App.
 * Scopes to an organization when `org` is provided.
 */
function buildCreateUrl(org: string | undefined): string {
  const login = (org ?? "").trim();
  if (login) {
    return `https://github.com/organizations/${encodeURIComponent(
      login
    )}/settings/apps/new`;
  }
  return "https://github.com/settings/apps/new";
}

/** Build the GitHub App manifest object from resolved settings. */
export function buildManifest(params: {
  name: string;
  publicUrl: string;
  webhookUrl: string;
  webhookSecret: string;
}): GithubAppManifest {
  return {
    name: params.name,
    url: params.publicUrl,
    hook_attributes: {
      url: params.webhookUrl,
      active: true,
      secret: params.webhookSecret,
    },
    redirect_url: `${params.publicUrl}/`,
    public: false,
    default_permissions: { ...PROPR_APP_PERMISSIONS },
    default_events: [...PROPR_WEBHOOK_EVENTS],
  };
}

/** Build the `.env` snippet for direct webhook mode. */
export function buildEnvSnippet(params: {
  webhookUrl: string;
  webhookSecret: string;
}): string {
  return `# Generated by \`propr github-app manifest\`.
# Direct webhook intake settings for running ProPR with your own GitHub App.
# Append these to your .env (and fill in GH_APP_ID / GH_INSTALLATION_ID /
# HOST_GH_PRIVATE_KEY after creating and installing the App on GitHub).

GH_AUTH_MODE=app
GITHUB_EVENT_INTAKE_MODE=direct_webhook
GH_WEBHOOK_SECRET=${params.webhookSecret}

# Public webhook endpoint GitHub will deliver events to:
#   ${params.webhookUrl}

# Fill these in from the created GitHub App:
# GH_APP_ID=
# GH_INSTALLATION_ID=
# Absolute host path to the App's private key (.pem). The propr CLI/launcher
# bind-mounts it (read-only) into the app containers, so it can live anywhere on
# the host. Must be an absolute path (no '~').
# HOST_GH_PRIVATE_KEY=/absolute/path/to/github-app-private-key.pem
`;
}

/**
 * Generate the GitHub App manifest JSON and matching `.env` snippet on disk.
 *
 * Safe to run repeatedly: refuses to overwrite existing output files unless
 * `force` is set.
 */
export async function generateGithubAppManifest(
  options: GenerateManifestOptions
): Promise<GenerateManifestResult> {
  const directory = options.root ? path.resolve(options.root) : process.cwd();
  const publicUrl = resolvePublicUrl(options.publicUrl);
  const webhookUrl = resolveWebhookUrl(options.webhookUrl, publicUrl);

  const name = (options.name ?? "ProPR").trim() || "ProPR";
  const webhookSecret =
    options.webhookSecret && options.webhookSecret.trim()
      ? options.webhookSecret.trim()
      : generateWebhookSecret();

  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const envPath = path.join(directory, ENV_FILENAME);

  const manifest = buildManifest({ name, publicUrl, webhookUrl, webhookSecret });
  const envSnippet = buildEnvSnippet({ webhookUrl, webhookSecret });

  // Create the target directory so a missing --root yields output rather than a
  // raw ENOENT.
  await mkdir(directory, { recursive: true });

  // Preflight both targets before writing anything. Without this, writing the
  // manifest first and then hitting an existing env file would leave a freshly
  // written manifest beside a refused env file — mixed/partial output despite
  // refusing to overwrite. Checking both up front means we either write both or
  // neither.
  if (!options.force) {
    await assertDoesNotExist(manifestPath);
    await assertDoesNotExist(envPath);
  }

  // Without --force, write exclusively ("wx") so a concurrent process cannot
  // slip a file in between the preflight check and the write (TOCTOU). The flag
  // is the actual guarantee; we translate the EEXIST into a friendly message.
  const writeFlag = options.force ? "w" : "wx";
  await writeManifestFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    writeFlag
  );
  await writeManifestFile(envPath, envSnippet, writeFlag);

  return {
    directory,
    manifestPath,
    envPath,
    publicUrl,
    webhookUrl,
    webhookSecret,
    manifest,
    createUrl: buildCreateUrl(options.org),
  };
}

/** Throw the friendly overwrite error if `filePath` already exists. */
async function assertDoesNotExist(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    // Missing (or otherwise inaccessible) — nothing to refuse. The exclusive
    // "wx" write remains the authoritative TOCTOU guard.
    return;
  }
  throw new Error(
    `Refusing to overwrite existing file: ${path.basename(
      filePath
    )}. Re-run with --force to overwrite.`
  );
}

/** Write a file, surfacing a friendly overwrite error when using "wx". */
async function writeManifestFile(
  filePath: string,
  contents: string,
  flag: "w" | "wx"
): Promise<void> {
  try {
    await writeFile(filePath, contents, { encoding: "utf-8", flag });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite existing file: ${path.basename(
          filePath
        )}. Re-run with --force to overwrite.`
      );
    }
    throw error;
  }
}

/** Placeholder substituted for the webhook secret in JSON output. */
const REDACTED_SECRET = "<written to env file; not printed>";

/**
 * Return a copy of the result with the webhook secret redacted everywhere it
 * appears (top-level and inside the manifest's hook attributes), so `--json`
 * does not leak the secret to stdout.
 */
export function redactSecret(
  result: GenerateManifestResult
): GenerateManifestResult {
  return {
    ...result,
    webhookSecret: REDACTED_SECRET,
    manifest: {
      ...result.manifest,
      hook_attributes: {
        ...result.manifest.hook_attributes,
        secret: REDACTED_SECRET,
      },
    },
  };
}

function displayResult(result: GenerateManifestResult): void {
  console.log("Generated GitHub App manifest for direct webhook mode:");
  console.log(`  Manifest: ${result.manifestPath}`);
  console.log(`  Env file: ${result.envPath}`);
  console.log("");
  console.log(`  Webhook URL: ${result.webhookUrl}`);
  console.log(
    `  Webhook secret: written to ${path.basename(result.envPath)} (not printed)`
  );
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Open GitHub's "Register new GitHub App" page:\n     ${result.createUrl}`
  );
  console.log(
    `     Then fill in the form using ${path.basename(result.manifestPath)} as a`
  );
  console.log(
    "     reference — name, homepage URL, webhook URL + secret, the listed"
  );
  console.log(
    "     repository permissions, and the subscribed events. (The manifest is"
  );
  console.log(
    "     also valid input for GitHub's automated App-manifest flow if you host"
  );
  console.log("     one.)");
  console.log(
    `  2. Append ${path.basename(result.envPath)} to your .env and fill in`
  );
  console.log("     GH_APP_ID, GH_INSTALLATION_ID, and HOST_GH_PRIVATE_KEY.");
}

export function createGithubAppCommand(): Command {
  const command = new Command("github-app");

  command.description(
    "Helpers for running ProPR with your own GitHub App (direct webhook mode)"
  );

  command
    .command("manifest")
    .description(
      "Generate a GitHub App manifest + matching .env snippet for direct webhook mode"
    )
    .requiredOption(
      "--public-url <url>",
      "Public base URL GitHub can reach (e.g. https://propr.example.com)"
    )
    .option(
      "--root <path>",
      "Directory to write output files into (default: current directory)"
    )
    .option(
      "--webhook-url <url>",
      "Override the webhook delivery URL (default: <public-url>/webhook)"
    )
    .option("--name <name>", "GitHub App name in the manifest", "ProPR")
    .option(
      "--webhook-secret <secret>",
      "Webhook secret to use (default: a generated cryptographically strong secret)"
    )
    .option(
      "--org <login>",
      "Scope App creation to an organization (default: personal account)"
    )
    .option("-f, --force", "Overwrite existing output files")
    .option("-j, --json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Example:
  $ propr github-app manifest --root /srv/propr --public-url https://propr.example.com

Writes ${MANIFEST_FILENAME} and ${ENV_FILENAME} into the target directory.
`
    )
    .action(
      async (options: {
        publicUrl: string;
        root?: string;
        webhookUrl?: string;
        name?: string;
        webhookSecret?: string;
        org?: string;
        force?: boolean;
        json?: boolean;
      }) => {
        try {
          const result = await generateGithubAppManifest({
            root: options.root,
            publicUrl: options.publicUrl,
            webhookUrl: options.webhookUrl,
            name: options.name,
            webhookSecret: options.webhookSecret,
            org: options.org,
            force: options.force,
          });

          if (options.json) {
            // The webhook secret is written to disk, not meant for stdout. Redact
            // it (and the copy nested in the manifest) so JSON output is not a
            // secret-bearing channel, mirroring the human output which never
            // prints it.
            printOutput(redactSecret(result), true);
            return;
          }
          displayResult(result);
        } catch (error) {
          console.error(
            `Error generating GitHub App manifest: ${(error as Error).message}`
          );
          process.exit(1);
        }
      }
    );

  return command;
}
