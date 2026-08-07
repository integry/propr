export function buildAnalysisSafetySuffix(
    responseFormat: 'text' | 'json',
    allowReadOnlyCommands: boolean,
    readOnlyWorkspacePath: string | undefined
): string {
    const commandPolicy = allowReadOnlyCommands && readOnlyWorkspacePath
        ? 'Use only the repository file read, glob, and text search tools. The workspace is mounted read-only. Do not run shell commands, modify files, install dependencies, or access the network.'
        : 'Do not modify any files. Do not run any commands.';
    return responseFormat === 'json'
        ? `\n\nCRITICAL: ${commandPolicy} Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.`
        : `\n\nCRITICAL: ${commandPolicy} Only provide your analysis as plain text output.`;
}
