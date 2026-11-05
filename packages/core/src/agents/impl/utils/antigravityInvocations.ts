/** Split a goal's recorded stream into its invocations, each starting at an `init` envelope. */
export function splitAntigravityInvocations(output: string): string[] {
    const invocations: string[][] = [[]];
    let initialized = false;
    for (const line of output.split('\n')) {
        const init = /^\s*\{\s*"event"\s*:\s*"init"/.test(line);
        // Container diagnostics before the first init belong to that invocation.
        if (init && initialized) invocations.push([]);
        initialized ||= init;
        invocations[invocations.length - 1].push(line);
    }
    return invocations.map(lines => lines.join('\n'));
}
