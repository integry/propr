// node:test reporter for the CI proof wrappers (see node-test-proof.mjs).
//
// Writes one JSON object per line for the runner events the wrappers validate:
// per-test outcomes, the per-file `test:summary` the runner emits after each
// file's process finishes, and the final run summary. A trailing `end` record
// is written only after the runner's event stream is exhausted, so a missing
// record means the run was truncated. Error messages are not copied; the spec
// reporter prints them for humans.

export default async function* nodeTestProofReporter(source) {
    for await (const event of source) {
        const data = event.data ?? {};
        if (event.type === 'test:pass' || event.type === 'test:fail') {
            yield `${JSON.stringify({
                type: event.type,
                file: data.file,
                name: data.name,
                nesting: data.nesting,
                testType: data.details?.type,
                skip: data.skip !== undefined && data.skip !== false,
                todo: data.todo !== undefined && data.todo !== false,
                failureType: data.details?.error?.failureType,
            })}\n`;
        } else if (event.type === 'test:summary') {
            yield `${JSON.stringify({
                type: event.type,
                file: data.file,
                counts: data.counts,
                success: data.success,
            })}\n`;
        }
    }
    yield `${JSON.stringify({ type: 'end' })}\n`;
}
