/**
 * Live stack dashboard (ink).
 *
 * Polls `getStackStatus` on an interval and renders a service table. The stack
 * containers run detached, so:
 *   b / Ctrl-C  → leave the stack running, exit the viewer ("background")
 *   q           → stop + remove the stack, then exit ("stopped")
 *   l           → toggle a follow-logs pane for the selected service
 *   ↑/↓         → select a service
 *   u           → toggle the UI service
 *   r           → refresh now
 *   ?           → toggle help
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ChildProcess } from "node:child_process";
import type { OrchestratorConfig, OrchestratorModule, StackStatus, ServiceState } from "../orchestrator/index.js";
import type { ConfigManager } from "../config/index.js";

const POLL_INTERVAL_MS = 1500;
const LOG_LINES = 14;

interface Props {
  orch: OrchestratorModule;
  cfg: OrchestratorConfig;
  configManager?: ConfigManager;
  onResult: (outcome: "background" | "stopped") => void;
}

function stateColor(s: ServiceState): string {
  if (!s.exists) return "gray";
  if (s.running) return "green";
  return "yellow";
}

function glyph(s: ServiceState): string {
  if (!s.exists) return "·";
  if (s.running) return "●";
  return "○";
}

export function StartApp({ orch, cfg, configManager, onResult }: Props): React.ReactElement {
  const { exit } = useApp();
  const [status, setStatus] = useState<StackStatus>(() => orch.getStackStatus(cfg));
  const [selected, setSelected] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [message, setMessage] = useState<string>("");
  const logProcRef = useRef<ChildProcess | null>(null);

  const services = status.services;
  const current = services[selected];

  // Poll stack status.
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setStatus(orch.getStackStatus(cfg));
      } catch {
        /* transient docker error — keep last status */
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [orch, cfg]);

  // Follow logs for the selected service when the pane is open.
  const currentService = current?.service;
  const currentExists = current?.exists;
  useEffect(() => {
    if (!showLogs) return;
    if (!currentService || !currentExists) {
      setLogLines(["(service not running)"]);
      return;
    }
    setLogLines([]);
    const proc = orch.getServiceLogs(cfg, currentService, {
      follow: true,
      tail: LOG_LINES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    logProcRef.current = proc;
    const onData = (buf: Buffer): void => {
      const incoming = buf.toString().split("\n").filter((l) => l.length > 0);
      setLogLines((prev) => [...prev, ...incoming].slice(-LOG_LINES));
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    return () => {
      proc.kill();
      logProcRef.current = null;
    };
  }, [showLogs, currentService, currentExists, orch, cfg]);

  const background = (): void => {
    logProcRef.current?.kill();
    onResult("background");
    exit();
  };

  const stop = (): void => {
    logProcRef.current?.kill();
    setMessage("Stopping stack…");
    try {
      orch.stopStack(cfg, { remove: true, removeNetwork: true });
    } catch {
      /* ignore — report outcome regardless */
    }
    onResult("stopped");
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      background();
      return;
    }
    if (input === "b") {
      background();
      return;
    }
    if (input === "q") {
      stop();
      return;
    }
    if (input === "l") {
      setShowLogs((v) => !v);
      return;
    }
    if (input === "?") {
      setShowHelp((v) => !v);
      return;
    }
    if (input === "r") {
      try {
        setStatus(orch.getStackStatus(cfg));
      } catch {
        /* ignore */
      }
      return;
    }
    if (input === "u") {
      const freshServices = orch.getStackStatus(cfg).services;
      const ui = freshServices.find((s) => s.service === "ui");
      try {
        if (ui?.running) {
          orch.stopService(cfg, "ui", { remove: true });
          configManager?.setUiEnabled(false).catch((e: Error) => setMessage(`UI stopped (config save failed: ${e.message})`));
          setMessage("UI stopped");
        } else {
          orch.startService(cfg, "ui");
          configManager?.setUiEnabled(true).catch((e: Error) => setMessage(`UI started (config save failed: ${e.message})`));
          setMessage("UI started");
        }
        setStatus(orch.getStackStatus(cfg));
      } catch (e) {
        setMessage(`UI toggle failed: ${(e as Error).message}`);
      }
      return;
    }
    if (key.upArrow) {
      setSelected((i) => (i - 1 + services.length) % services.length);
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % services.length);
    }
  });

  const nameWidth = Math.max(...services.map((s) => s.service.length), 8);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>ProPR </Text>
        <Text color="cyan">{status.stack}</Text>
        <Text dimColor>  ·  network {status.network}  ·  </Text>
        <Text color={status.running ? "green" : "yellow"}>{status.running ? "running" : "stopped"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {services.map((s, i) => (
          <Box key={s.service}>
            <Text inverse={i === selected}>
              <Text color={stateColor(s)}>{glyph(s)} </Text>
              <Text>{s.service.padEnd(nameWidth)} </Text>
              <Text dimColor>{(s.exists ? s.state : "absent").padEnd(10)} </Text>
              <Text>{s.exists ? s.status : "not created"}</Text>
              {s.ports ? <Text dimColor>  {s.ports}</Text> : null}
            </Text>
          </Box>
        ))}
      </Box>

      {showLogs && current ? (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>logs: {current.service} (l to close)</Text>
          {logLines.length === 0 ? (
            <Text dimColor>(waiting for output…)</Text>
          ) : (
            logLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))
          )}
        </Box>
      ) : null}

      {showHelp ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>b = background (keep running)   q = stop stack   l = logs</Text>
          <Text dimColor>↑/↓ = select   u = toggle UI   r = refresh   ? = help</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>b background · q stop · l logs · ↑/↓ select · u UI · r refresh · ? help</Text>
        </Box>
      )}

      {message ? (
        <Box marginTop={1}>
          <Text color="magenta">{message}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
