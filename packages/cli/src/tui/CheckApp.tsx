/**
 * Ink renderer for `propr check` in interactive terminals.
 */

import React, { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import {
  CHECK_GROUPS,
  countStatuses,
  plural,
  type CheckResult,
  type CheckStatus,
  type ChecksOutcome,
} from "../commands/checkCommands.js";

interface Props {
  outcome: ChecksOutcome;
  showRemediationHint?: boolean;
}

const STATUS_GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

function statusColor(status: CheckStatus): string {
  if (status === "ok") return "green";
  if (status === "warn") return "yellow";
  return "red";
}

function Summary({ results }: { results: CheckResult[] }): React.ReactElement {
  const counts = countStatuses(results);
  return (
    <Box>
      <Text>Summary: </Text>
      <Text color={counts.fail > 0 ? "red" : undefined} bold={counts.fail > 0}>{plural(counts.fail, "failure")}</Text>
      <Text>, </Text>
      <Text color={counts.warn > 0 ? "yellow" : undefined} bold={counts.warn > 0}>{plural(counts.warn, "warning")}</Text>
      <Text>, </Text>
      <Text color="green">{counts.ok} ok</Text>
    </Box>
  );
}

function ResultRow({ result, nameWidth }: { result: CheckResult; nameWidth: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor(result.status)} bold>
          {STATUS_GLYPH[result.status]} {STATUS_LABEL[result.status].padEnd(4)}
        </Text>
        <Text> {result.name.padEnd(nameWidth)}  </Text>
        <Text>{result.detail}</Text>
      </Box>
      {result.fix && result.status !== "ok" ? (
        <Box paddingLeft={9}>
          <Text dimColor>↳ </Text>
          <Text>{result.fix}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CheckApp({ outcome, showRemediationHint }: Props): React.ReactElement {
  const { exit } = useApp();

  useEffect(() => {
    const timer = setTimeout(() => exit(), 20);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>ProPR environment check</Text>
        <Text dimColor>  (stack root: {outcome.rootDir})</Text>
      </Box>
      <Summary results={outcome.results} />

      {CHECK_GROUPS.map((group) => {
        const groupResults = outcome.results.filter((result) => result.group === group);
        if (groupResults.length === 0) return null;
        const groupCounts = countStatuses(groupResults);
        const nameWidth = Math.max(18, ...groupResults.map((result) => result.name.length));
        const countSuffix = groupCounts.fail > 0 || groupCounts.warn > 0
          ? ` (${plural(groupCounts.fail, "failure")}, ${plural(groupCounts.warn, "warning")})`
          : "";
        return (
          <Box key={group} marginTop={1} flexDirection="column">
            <Text color="cyan" bold>{group}{countSuffix}</Text>
            {groupResults.map((result) => (
              <ResultRow key={`${result.name}:${result.detail}`} result={result} nameWidth={nameWidth} />
            ))}
          </Box>
        );
      })}

      {outcome.results.some((result) => !result.group) ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Other</Text>
          {outcome.results.filter((result) => !result.group).map((result) => (
            <ResultRow key={`${result.name}:${result.detail}`} result={result} nameWidth={18} />
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Summary results={outcome.results} />
      </Box>
      {showRemediationHint ? (
        <Box marginTop={1}>
          <Text dimColor>Run `propr check --fix` to review interactive remediation options.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
