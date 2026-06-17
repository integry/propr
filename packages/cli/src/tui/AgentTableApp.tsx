/**
 * Live Ink table for `propr check` agent validation. Renders one row per agent
 * with spinner placeholders, then fills each cell (version, host, image) in as
 * the corresponding check resolves — mirroring the streaming system-check view.
 */

import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp } from "ink";
import type { AgentCell, AgentCellUpdate } from "../commands/agentValidation.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VW = 10; // version column width
const DW = 6; // drift column width
const SW = 7; // status column width
const GAP = 2;

export type AgentTableEvent = { type: "update"; agent: string; update: AgentCellUpdate } | { type: "done" };

/** Pub/sub bridge between the streaming validator and the React tree. */
export class AgentTableHub {
  private listeners = new Set<(event: AgentTableEvent) => void>();
  emit(event: AgentTableEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  subscribe(listener: (event: AgentTableEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface RowData {
  type: string;
  versionDone: boolean;
  hostVersion?: string;
  imageVersion?: string;
  drift?: "older" | "newer";
  host?: AgentCell;
  image?: AgentCell;
}

function reducer(rows: RowData[], event: AgentTableEvent): RowData[] {
  if (event.type !== "update") return rows;
  return rows.map((r) => {
    if (r.type !== event.agent) return r;
    const u = event.update;
    if (u.field === "version") return { ...r, versionDone: true, hostVersion: u.hostVersion, imageVersion: u.imageVersion, drift: u.drift };
    if (u.field === "host") return { ...r, host: u.cell };
    return { ...r, image: u.cell };
  });
}

function StatusCell({ cell, frame }: { cell?: AgentCell; frame: number }): React.ReactElement {
  if (!cell) return <Text color="cyan">{SPINNER[frame % SPINNER.length]} run</Text>;
  if (cell.status === "ok") return <Text color="green">✓ ok</Text>;
  if (cell.status === "fail") return <Text color="red">✗ fail</Text>;
  return <Text color="yellow">— skip</Text>;
}

interface Props {
  agents: string[];
  hub: AgentTableHub;
}

export function AgentTableApp({ agents, hub }: Props): React.ReactElement {
  const { exit } = useApp();
  const [rows, dispatch] = useReducer(
    reducer,
    agents.map((type) => ({ type, versionDone: false }))
  );
  const [frame, setFrame] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    return hub.subscribe((event) => {
      if (event.type === "done") setDone(true);
      else dispatch(event);
    });
  }, [hub]);

  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(timer);
  }, [done]);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => exit(), 20);
    return () => clearTimeout(timer);
  }, [done, exit]);

  const agentW = Math.max("Agent".length, ...agents.map((a) => a.length));

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={agentW + GAP}><Text bold>Agent</Text></Box>
        <Box width={VW + GAP}><Text bold>Host ver</Text></Box>
        <Box width={VW + GAP}><Text bold>Image ver</Text></Box>
        <Box width={DW + GAP}><Text bold>Drift</Text></Box>
        <Box width={SW + GAP}><Text bold>Host</Text></Box>
        <Box width={SW}><Text bold>Image</Text></Box>
      </Box>
      {rows.map((r) => {
        const drift = r.versionDone ? (r.drift ?? (r.hostVersion && r.imageVersion ? "same" : "")) : "";
        const driftColor = drift === "older" ? "yellow" : drift && drift !== "same" ? "gray" : "gray";
        return (
          <Box key={r.type}>
            <Box width={agentW + GAP}><Text>{r.type}</Text></Box>
            <Box width={VW + GAP}>
              {r.versionDone ? <Text>{r.hostVersion ?? "—"}</Text> : <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>}
            </Box>
            <Box width={VW + GAP}><Text>{r.versionDone ? (r.imageVersion ?? "—") : ""}</Text></Box>
            <Box width={DW + GAP}><Text color={driftColor}>{drift}</Text></Box>
            <Box width={SW + GAP}><StatusCell cell={r.host} frame={frame} /></Box>
            <Box width={SW}><StatusCell cell={r.image} frame={frame} /></Box>
          </Box>
        );
      })}
    </Box>
  );
}
