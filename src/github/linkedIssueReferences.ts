const LINKED_ISSUE_REFERENCE = /(?:closes|fixes|resolves|addresses)\s+#(\d+)/gi;

/** Issue numbers a pull request body links with `Closes #n` and its synonyms, in order and without repeats. */
export function parseLinkedIssueNumbers(body: string | null | undefined): number[] {
    return Array.from(body?.matchAll(LINKED_ISSUE_REFERENCE) ?? [])
        .map(match => parseInt(match[1], 10))
        .filter((issueNumber, index, all) => Number.isFinite(issueNumber) && all.indexOf(issueNumber) === index);
}
