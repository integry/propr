import {
    boundedProviderOutput,
    MAX_PROVIDER_OUTPUT_BYTES,
} from '../../agents/impl/utils/boundedProviderOutput.js';

export interface LiveOutputSnapshot {
    text: string;
    /**
     * The transcript's oldest records, dropped to fit the byte budget. The
     * snapshot is published as starting that far into the execution, so its
     * records keep the positions they had before the transcript outgrew it.
     */
    discarded: string;
}

/**
 * Event IDs derive from a record's offset within the snapshot, so a section
 * that grows must not move the records of the sections before it: the
 * transcript (append-only, and readable) comes first, then the process's
 * stdout, then its stderr diagnostics. Earlier sections also take precedence
 * for the byte budget, so diagnostics never push the transcript out.
 */
export function buildLiveOutputSnapshot(transcript: string, stdout: string, stderr: string, maximumBytes = MAX_PROVIDER_OUTPUT_BYTES): LiveOutputSnapshot {
    const sections: string[] = [];
    let remaining = maximumBytes;
    let discarded = '';
    for (const [index, section] of [transcript, stdout, stderr].entries()) {
        const separator = sections.length > 0 ? 1 : 0;
        const bounded = boundedProviderOutput(section, remaining - separator);
        // The bounded transcript is a suffix of it; the sections after it may move anyway.
        if (index === 0) discarded = transcript.slice(0, transcript.length - bounded.length);
        if (!bounded) continue;
        sections.push(bounded);
        remaining -= Buffer.byteLength(bounded) + separator;
    }
    return { text: sections.join('\n'), discarded };
}
