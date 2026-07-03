/**
 * Shared interactive confirmation prompt.
 *
 * In non-interactive contexts (CI, piped stdin) a readline question would
 * never resolve on stdin EOF and the command would hang, so we refuse to
 * prompt and treat the action as declined — callers' --force/--yes flags are
 * the non-interactive path.
 */
export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      "Refusing to prompt for confirmation in non-interactive mode; pass --force to proceed."
    );
    return false;
  }

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
