import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const deployScript = resolve("scripts/deploy-pr.sh");

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runPreviewDeploy({ stoppedService = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "propr-preview-test-"));
  const checkout = join(root, "checkout");
  const fakeBin = join(root, "bin");
  const stagingEnv = join(root, "staging.env");
  mkdirSync(checkout);
  mkdirSync(fakeBin);
  writeFileSync(join(checkout, "docker-compose.yml"), "services: {}\n");
  writeFileSync(stagingEnv, [
    "GH_AUTH_MODE=relay",
    "PROPR_GH_RELAY_URL=https://relay.example.test",
    "PROPR_GH_RELAY_TOKEN=relay-secret-with-symbols_#%",
    "GITHUB_EVENT_INTAKE_MODE=routing_websocket",
    "GH_OAUTH_CLIENT_ID=client-id",
    "GH_OAUTH_CLIENT_SECRET=oauth-secret",
    "GH_OAUTH_CALLBACK_URL=https://api.example.test/callback",
    "SESSION_SECRET=session-secret",
    "MISTRAL_API_KEY=must-not-leak",
    "GH_WEBHOOK_SECRET=must-not-leak-either",
    "DB_FILENAME=/does/not/exist.sqlite",
    "",
  ].join("\n"));

  writeExecutable(join(fakeBin, "docker"), `#!/bin/sh
if [ "$1" = "network" ]; then
  echo "172.17.0.1"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  for last_arg do :; done
  case "$last_arg" in
    "${stoppedService}-container") echo "false" ;;
    *) echo "true" ;;
  esac
  exit 0
fi
case " $* " in
  *" ps -q "*)
    for last_arg do :; done
    echo "\${last_arg}-container"
    ;;
esac
exit 0
`);

  writeExecutable(join(fakeBin, "curl"), "#!/bin/sh\nexit 0\n");

  const result = spawnSync("sh", [deployScript, "2061"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: root,
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      PR_SOURCE_DIR: checkout,
      PR_HEAD_SHA: "1234567890abcdef",
      PR_HAS_DEMO_LABEL: "false",
      STAGING_ENV_FILE: stagingEnv,
      STAGING_DB_PATH: "",
    },
  });

  try {
    return {
      ...result,
      previewEnv: readFileSync(join(checkout, ".env"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("preview deploy preserves only the credentials required by relay-backed previews", () => {
  const result = runPreviewDeploy();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.previewEnv, /^PROPR_GH_RELAY_TOKEN=relay-secret-with-symbols_#%$/m);
  assert.match(result.previewEnv, /^GH_OAUTH_CLIENT_SECRET=oauth-secret$/m);
  assert.match(result.previewEnv, /^SESSION_SECRET=session-secret$/m);
  assert.doesNotMatch(result.previewEnv, /^MISTRAL_API_KEY=/m);
  assert.doesNotMatch(result.previewEnv, /^GH_WEBHOOK_SECRET=/m);
  assert.match(result.stdout, /API health check passed/);
});

test("preview deploy fails when a backend container exits after compose up", () => {
  const result = runPreviewDeploy({ stoppedService: "api" });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Preview API did not become healthy/);
  assert.match(result.stdout, /Preview backend services are not running: api/);
  assert.doesNotMatch(result.stdout, /Preview environment is now available/);
});
