import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalSpawnSync = childProcess.spawnSync;
const forbidden = /(?:connect-authority|ProPRConnectAuthority|powershell|pwsh|csc|msiexec)(?:\.exe)?$/i;

childProcess.spawnSync = (command, args, options) => {
  const executable = String(command);
  if (forbidden.test(executable)) throw new Error("forbidden Windows authority executable");
  if (executable.toLowerCase() !== "docker") return originalSpawnSync(command, args, options);
  const expected = [
    "ps", "-a", "--filter", "label=propr.stack=authorized", "--format",
    "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    return { status: 9, signal: null, error: undefined, stdout: "", stderr: "docker-argv-SENTINEL" };
  }
  const stdout = process.env.PROPR_TEST_DOCKER_MODE === "down"
    ? ""
    : "authorized-tunnel\trunning\tUp 1 second\t\r\n";
  return {
    status: 0,
    signal: null,
    error: undefined,
    stdout,
    stderr: "docker-secret-SENTINEL",
  };
};
syncBuiltinESMExports();
