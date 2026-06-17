/**
 * Live Ink renderer for `propr check` in interactive terminals.
 *
 * Rather than rendering a finished report, this subscribes to a CheckHub fed by
 * the streaming check engine: rows appear as each check resolves, slow checks
 * (image freshness) show an animated spinner while they run, and the summary
 * header updates live. With --fix, it ends in an arrow-key remediation menu;
 * the selected action's key is reported to the caller, which runs it (and any
 * console output) outside the Ink tree before re-rendering a fresh pass.
 */

import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  CHECK_GROUPS,
  GROUP_DESCRIPTIONS,
  GROUP_TITLES,
  plural,
  type CheckGroup,
  type CheckResult,
  type CheckStatus,
  type ChecksOutcome,
} from "../commands/checkCommands.js";

export type CheckEvent =
  | { type: "pending"; slot: { name: string; group?: CheckGroup } }
  | { type: "result"; result: CheckResult }
  | { type: "done"; outcome: ChecksOutcome }
  | { type: "error"; error: Error };

/** Minimal pub/sub bridge between the async engine and the React tree. */
export class CheckHub {
  private listeners = new Set<(event: CheckEvent) => void>();
  emit(event: CheckEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  subscribe(listener: (event: CheckEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface RemediationMenuItem {
  key: string;
  label: string;
  detail: string;
  confirm: string;
}

interface Props {
  hub: CheckHub;
  fix: boolean;
  getActions: (outcome: ChecksOutcome) => RemediationMenuItem[];
  onSelect: (key: string | undefined) => void;
  /** When true (and not in --fix mode), offer a y/N agent-validation prompt at the end. */
  offerValidate?: boolean;
  /** Reports the agent-validation choice (only meaningful when offerValidate). */
  onValidate?: (yes: boolean) => void;
}

type RowStatus = CheckStatus | "pending";

interface Row {
  id: number;
  name: string;
  group?: CheckGroup;
  status: RowStatus;
  detail?: string;
  fix?: string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

function statusColor(status: CheckStatus): string {
  if (status === "ok") return "green";
  if (status === "warn") return "yellow";
  return "red";
}

function countRowStatuses(rows: Array<{ status: CheckStatus }>): Record<CheckStatus, number> {
  return rows.reduce(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>
  );
}

// A "pending" slot (only emitted for images, whose names are unique) is upserted
// in place when its result arrives. Every other result is appended with a fresh
// id, so checks that share a name (e.g. several "Config error" rows) all show.
type RowState = { rows: Row[]; pendingByName: Map<string, number>; nextId: number };

function rowReducer(state: RowState, event: CheckEvent): RowState {
  if (event.type === "pending") {
    if (state.pendingByName.has(event.slot.name)) return state;
    const id = state.nextId;
    const pendingByName = new Map(state.pendingByName).set(event.slot.name, id);
    return {
      rows: [...state.rows, { id, name: event.slot.name, group: event.slot.group, status: "pending" }],
      pendingByName,
      nextId: id + 1,
    };
  }
  if (event.type === "result") {
    const { result } = event;
    const pendingId = state.pendingByName.get(result.name);
    if (pendingId !== undefined) {
      const pendingByName = new Map(state.pendingByName);
      pendingByName.delete(result.name);
      return {
        rows: state.rows.map((row) =>
          row.id === pendingId
            ? { id: pendingId, name: result.name, group: result.group, status: result.status, detail: result.detail, fix: result.fix }
            : row
        ),
        pendingByName,
        nextId: state.nextId,
      };
    }
    const id = state.nextId;
    return {
      rows: [...state.rows, { id, name: result.name, group: result.group, status: result.status, detail: result.detail, fix: result.fix }],
      pendingByName: state.pendingByName,
      nextId: id + 1,
    };
  }
  return state;
}

function StatusBadge({ status, frame }: { status: RowStatus; frame: number }): React.ReactElement {
  if (status === "pending") {
    return (
      <Text color="cyan" bold>
        {SPINNER[frame % SPINNER.length]} ····
      </Text>
    );
  }
  return (
    <Text color={statusColor(status)} bold>
      {STATUS_GLYPH[status]} {STATUS_LABEL[status].padEnd(4)}
    </Text>
  );
}

function ResultRow({ row, nameWidth, frame }: { row: Row; nameWidth: number; frame: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0}>
          <StatusBadge status={row.status} frame={frame} />
          <Text> {row.name.padEnd(nameWidth)}  </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>{row.status === "pending" ? <Text dimColor>checking…</Text> : row.detail}</Text>
        </Box>
      </Box>
      {row.fix && row.status !== "ok" && row.status !== "pending" ? (
        <Box paddingLeft={9}>
          <Box marginRight={1}><Text dimColor>↳</Text></Box>
          <Box flexGrow={1}><Text>{row.fix}</Text></Box>
        </Box>
      ) : null}
    </Box>
  );
}

function SummaryLine({ rows, running }: { rows: Row[]; running: boolean }): React.ReactElement {
  const finalized = rows.filter((row): row is Row & { status: CheckStatus } => row.status !== "pending");
  const counts = countRowStatuses(finalized);
  return (
    <Box>
      <Text>Summary: </Text>
      <Text color={counts.fail > 0 ? "red" : undefined} bold={counts.fail > 0}>{plural(counts.fail, "failure")}</Text>
      <Text>, </Text>
      <Text color={counts.warn > 0 ? "yellow" : undefined} bold={counts.warn > 0}>{plural(counts.warn, "warning")}</Text>
      <Text>, </Text>
      <Text color="green">{counts.ok} ok</Text>
      {running ? <Text dimColor> · checking…</Text> : null}
    </Box>
  );
}

function Groups({ rows, frame }: { rows: Row[]; frame: number }): React.ReactElement {
  const sections: React.ReactElement[] = [];
  const groupsInOrder: (CheckGroup | undefined)[] = [...CHECK_GROUPS, undefined];

  for (const group of groupsInOrder) {
    const groupRows = rows.filter((row) => row.group === group);
    if (groupRows.length === 0) continue;
    const nameWidth = Math.max(18, ...groupRows.map((row) => row.name.length));
    const finalized = groupRows.filter((row): row is Row & { status: CheckStatus } => row.status !== "pending");
    const groupCounts = countRowStatuses(finalized);
    const countSuffix =
      groupCounts.fail > 0 || groupCounts.warn > 0
        ? ` (${plural(groupCounts.fail, "failure")}, ${plural(groupCounts.warn, "warning")})`
        : "";
    sections.push(
      <Box key={group ?? "Other"} marginTop={1} flexDirection="column">
        <Text color="cyan" bold>{group ? GROUP_TITLES[group] : "Other"}{countSuffix}</Text>
        {group ? <Text dimColor>  {GROUP_DESCRIPTIONS[group]}</Text> : null}
        {groupRows.map((row) => (
          <ResultRow key={row.id} row={row} nameWidth={nameWidth} frame={frame} />
        ))}
      </Box>
    );
  }
  return <>{sections}</>;
}

function Menu({ items, selected }: { items: RemediationMenuItem[]; selected: number }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>Remediations</Text>
      {items.map((item, index) => {
        const active = index === selected;
        return (
          <Box key={item.key} flexDirection="column">
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "❯ " : "  "}{item.label}
            </Text>
            <Box paddingLeft={4}><Text dimColor>{item.detail}</Text></Box>
          </Box>
        );
      })}
      <Box marginTop={1}><Text dimColor>↑/↓ select · enter choose · q quit</Text></Box>
    </Box>
  );
}

export function CheckApp({ hub, fix, getActions, onSelect, offerValidate, onValidate }: Props): React.ReactElement {
  const { exit } = useApp();
  const [rowState, dispatch] = useReducer(rowReducer, { rows: [], pendingByName: new Map<string, number>(), nextId: 0 });
  const [phase, setPhase] = useState<"running" | "menu" | "done" | "validate-confirm" | "action-confirm">("running");
  const [outcome, setOutcome] = useState<ChecksOutcome | null>(null);
  const [actions, setActions] = useState<RemediationMenuItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [frame, setFrame] = useState(0);
  const [errored, setErrored] = useState<Error | null>(null);

  useEffect(() => {
    return hub.subscribe((event) => {
      if (event.type === "done") {
        setOutcome(event.outcome);
        const available = fix ? getActions(event.outcome) : [];
        setActions(available);
        if (fix && available.length > 0) {
          setPhase("menu");
        } else if (offerValidate && !fix) {
          setPhase("validate-confirm");
        } else {
          setPhase("done");
        }
      } else if (event.type === "error") {
        setErrored(event.error);
        setPhase("done");
      } else {
        dispatch(event);
      }
    });
  }, [hub, fix, getActions, offerValidate]);

  // Animate the spinner only while checks are in flight.
  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(timer);
  }, [phase]);

  // Leave a short beat for the final frame to paint before unmounting.
  useEffect(() => {
    if (phase !== "done") return;
    onSelect(undefined);
    const timer = setTimeout(() => exit(errored ?? undefined), 20);
    return () => clearTimeout(timer);
  }, [phase, exit, onSelect, errored]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onSelect(undefined);
      onValidate?.(false);
      exit();
      return;
    }
    if (phase === "validate-confirm") {
      if (input.toLowerCase() === "y") onValidate?.(true);
      else onValidate?.(false); // n / enter / esc / anything else
      exit();
      return;
    }
    if (phase === "action-confirm") {
      if (input.toLowerCase() === "y") {
        onSelect(actions[selected]?.key);
        exit();
      } else {
        setPhase("menu");
      }
      return;
    }
    if (phase !== "menu") return;
    if (key.upArrow) setSelected((index) => (index - 1 + actions.length) % actions.length);
    else if (key.downArrow) setSelected((index) => (index + 1) % actions.length);
    else if (key.return) {
      setPhase("action-confirm");
    } else if (input === "q" || key.escape) {
      onSelect(undefined);
      exit();
    }
  });

  const rows = rowState.rows;
  const running = phase === "running";
  const showRemediationHint = !fix && phase === "done" && outcome != null && getActions(outcome).length > 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>ProPR environment check</Text>
        {outcome ? <Text dimColor>  (stack root: {outcome.rootDir})</Text> : null}
      </Box>
      <SummaryLine rows={rows} running={running} />

      <Groups rows={rows} frame={frame} />

      {errored ? (
        <Box marginTop={1}><Text color="red">Error running checks: {errored.message}</Text></Box>
      ) : null}

      {phase === "menu" ? <Menu items={actions} selected={selected} /> : null}

      {phase === "done" || phase === "validate-confirm" || phase === "action-confirm" ? (
        <Box marginTop={1}>
          <SummaryLine rows={rows} running={running} />
        </Box>
      ) : null}

      {phase === "validate-confirm" ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Validate agents?</Text>
          <Text>Make a live test call to each agent image to confirm auth works.</Text>
          <Text dimColor>This makes real, billable LLM calls. Press y to run, any other key to skip.</Text>
        </Box>
      ) : null}

      {phase === "action-confirm" ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Confirm remediation</Text>
          <Text>{actions[selected]?.confirm}</Text>
          <Text dimColor>Press y to run, any other key to go back.</Text>
        </Box>
      ) : null}

      {showRemediationHint ? (
        <Box marginTop={1}>
          <Text dimColor>Run `propr check --fix` to review interactive remediation options.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
