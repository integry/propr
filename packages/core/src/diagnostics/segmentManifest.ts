/** Compare a stored snapshot with current immutable segment metadata. Collection
 * status and policy may have advanced since a valid snapshot was sealed. */
export function segmentManifestMatches(storedManifest: string, currentManifest: string): boolean {
    try {
        const stored = JSON.parse(storedManifest) as Record<string, unknown> | null;
        const current = JSON.parse(currentManifest) as Record<string, unknown>;
        return ['schemaVersion', 'redactionVersion', 'tenantPrivate', 'instance', 'provider', 'agent', 'source', 'sourceId', 'segment', 'utcDay',
            'collectionWindow', 'firstSequence', 'lastSequence', 'compressedBytes', 'uncompressedBytes', 'sha256', 'encoding']
            .every(key => JSON.stringify(stored?.[key]) === JSON.stringify(current[key]));
    } catch { return false; }
}
